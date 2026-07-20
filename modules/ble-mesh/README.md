# ble-mesh

Our own BLE transport: **CoreBluetooth** on iOS, the **Android BLE GATT** stack on
Android. No Google Nearby, no Play services, no Wi-Fi, no infrastructure.

> **This module is a dumb byte pipe.** No message parsing, no application-level
> dedup, no storage, no crypto, no retries. It moves opaque bytes and reports peer
> and link lifecycle. Everything else belongs in JS. Please keep it that way.

Modules under `modules/` are autolinked by Expo automatically — nothing to install.

## Why this exists

`modules/nearby-mesh` is left in place for now and will be deleted once this is
proven on two physical phones. Two reasons it has to go:

1. **Nearby on iOS only supports the Wi-Fi LAN medium.** Both phones must already
   be on the same Wi-Fi network. At a protest with no infrastructure that is not a
   degraded path, it is no path at all. Google has never shipped iOS BLE for
   Nearby, and its iOS SDK is SPM-only with
   [no CocoaPods support](https://github.com/google/nearby/issues/1685), so it
   does not even build here.
2. **Nearby gives no control over its advertising identifier.** That is open
   problem #2 in `docs/THREAT-MODEL.md`. A stable BLE identifier is a tracking
   beacon: cheap receivers around a protest can log "this device was at gate 4 at
   14:02 and at the metro at 14:40" without breaking any cryptography. Owning the
   advertisement is the only way to rotate it.

## Every device is both roles

There is no client and no server in a mesh. Each phone simultaneously:

- runs a **GATT server** and advertises (peripheral role), and
- **scans and connects** to everyone it finds (central role).

Peers connect opportunistically in whichever direction wins the race. Two devices
that see each other at the same moment will both dial out and **both will
succeed**, producing one link in each direction carrying the same traffic twice.
That is handled, not prevented — see *duplicate links* below.

## GATT design

| | UUID | Properties |
| --- | --- | --- |
| Service | `7B3C1A80-9F42-4E17-9A6D-2C5E8B1F0D31` | primary |
| Inbound (peer → us) | `…0D31` ending `1A81` | `WRITE`, `WRITE_NO_RESPONSE` |
| Outbound (us → peer) | `…0D31` ending `1A82` | `NOTIFY` (+ CCCD on Android) |

Android requests **MTU 512** on connect, before service discovery — requesting it
afterwards leaves cached characteristics on some stacks and you frame at 20 bytes
forever. iOS has no `requestMtu`; it negotiates for you and the result is read
from `maximumWriteValueLength(for: .withoutResponse)` (central role) or
`CBCentral.maximumUpdateValueLength` (peripheral role).

**Until negotiation completes, 20 bytes is all we assume** (`MIN_USABLE_WRITE`) —
ATT_MTU 23 minus the 3-byte opcode and handle.

## Chunking lives in the native layer

`MAX_ENVELOPE_LEN` is 30 000 bytes. A BLE write is 20–512. So every payload is
split, and reassembled on the far side, before it becomes one `onPayload`.

**It is done natively, on both platforms, not in TypeScript.** That means two
implementations of the same framing, which is a cost this codebase does not
usually accept. Why it is the right call anyway:

- **The MTU is only known natively, per link, and only after negotiation.** TS
  would have to be told the chunk size for every peer and re-told when it changes.
- **Flow control is native-only and silent.** Android permits exactly one
  outstanding GATT operation per connection and *fails* the rest rather than
  queueing them; iOS goes false on `canSendWriteWithoutResponse` and returns
  `false` from `updateValue`. Neither reports an error. A TS chunker cannot see
  any of this, so it would deliver chunk 1 and silently discard chunks 2–60.
- **One bridge crossing per envelope instead of ~60.** At 500-byte chunks a 30 KB
  envelope is sixty base64 round trips through the bridge, per peer, per relay
  hop, in an epidemic protocol that re-broadcasts everything to everyone.
- **The reassembly bound has to be enforced where the bytes land.** If TS did the
  bounding, a hostile peer's chunks would already be allocated and queued on the
  bridge before the limit was consulted, which defeats the point of having one.

The cost is accepted because **framing is not security-critical**. It carries no
secrets and authenticates nothing: the payload it reassembles is sealed and
integrity-protected two layers up, so a framing bug is a *delivery* bug, not a
confidentiality one. A corrupted or spliced reassembly fails Poly1305 in
`crypto-core.ts` and is dropped. The byte layout is specified exactly below and
mirrored in `src/constants.ts` so the two implementations can be diffed.

### Frame layout — 8 bytes, big-endian

```
0      version    0x01
1      type       0x00 DATA | 0x01 HELLO
2..3   messageId  uint16, per link, per direction, wraps
4..5   chunkIndex uint16
6..7   chunkCount uint16
8..    payload
```

No length field (ATT delivers exact-length writes), no checksum (a corrupted
chunk fails Poly1305 above; a checksum here would only rename the failure) and no
retransmission (the mesh is epidemic — the same envelope arrives again from
someone else).

### Reassembly rules

Out-of-order and duplicate chunks are normal and both are handled: chunks are
stored by index and ordered only at completion; a repeat of an index already held
is ignored. **A partially reassembled payload is never emitted upward.**

The buffer is bounded three separate ways, because the far side is an untrusted
radio and a peer that opens thousands of messages it never finishes is the
cheapest possible denial of service against a phone:

| Bound | Value | Why |
| --- | --- | --- |
| Concurrent assemblies per peer | 4 | Caps pinned memory at 4 × 32 KiB per peer. The **oldest** is evicted, not the newest, so a flooder cannot lock out a transfer already in progress. |
| Bytes per message | 32 768 | Just above `MAX_ENVELOPE_LEN`, so the transport is never what rejects a legal envelope. |
| Age | 30 s | Abandoned assemblies are swept every 5 s. Far longer than a 30 KB transfer needs even at the 20-byte floor. |

Also rejected: `chunkCount == 0`, `chunkIndex >= chunkCount`, and a chunk whose
declared count disagrees with the count already recorded for that `messageId`
(which drops the whole assembly rather than splicing two messages together).

Single-chunk messages take a fast path that never touches the assembly table, so
a flood of small frames cannot evict a large transfer.

## Rotating identifiers

**The advertisement contains exactly two things: the service UUID, and a hex
string of four CSPRNG bytes.** It does not contain the display name, any part of
the user's public key, or anything derived from either — and it never will.

The tag is regenerated every **15 minutes** (`DEFAULT_ROTATION_MS`, matching the
Apple/Google exposure-notification rolling interval and the rate at which iOS
rotates its own resolvable private address). The new value is fresh CSPRNG output
and is **not derivable from the old one**: no counter, no hash chain, no key.
Anything derivable would be a stable identifier with extra steps.

Peer identity is established by the sealed payloads at the mesh layer, **not by
the advertisement**. This transport only ever deals in ephemeral, per-session
handles that are minted locally and mean nothing to anyone else.

Where the tag rides differs by platform because the platforms differ:

| | Publishes | Reads |
| --- | --- | --- |
| iOS | `CBAdvertisementDataLocalNameKey` — the only advertisement field CoreBluetooth lets an app set; service *data* is silently dropped | local name **and** service data |
| Android | scan-response **service data** — `setIncludeDeviceName(false)` is load-bearing, the device name is "Someone's Pixel" and is permanent | service data **and** `ScanRecord.getDeviceName()` |

Only 4 of the tag's 8 bytes are advertised: a BLE advertisement is 31 bytes and a
128-bit service UUID already spends 18 of them, so the full tag would overflow and
be truncated by the OS — a worse failure than deliberately publishing less. The
advertised tag is a **hint** used only to notice a rotation and to skip
re-connecting to something we already hold. The full 8-byte tag travels in-band in
the `HELLO` frame, which is the first frame sent in both directions on every link,
and that is what deduplication actually keys on.

### What this does *not* fix

An app cannot set the BLE **link-layer address**; that belongs to the OS. iOS uses
a resolvable private address and rotates it on its own schedule. Android
randomises per advertising set on most modern devices but does not guarantee it,
and some OEM stacks do not. All this module can do is fully stop and restart the
advertising set on each rotation, which is the only lever that gives the stack an
opportunity to re-randomise. **Our rotation is necessary but not sufficient**, and
RF direction-finding remains out of scope entirely — see the threat model.

Live links are deliberately **not** dropped on rotation. Cutting every link every
fifteen minutes would gut the mesh, and a link already established is already
correlated with us for its lifetime.

## Duplicate links

A link is announced to JS as `onConnected` only after the peer's `HELLO` has
arrived; before that it has no transport identity and cannot be addressed. If a
`HELLO` names a tag we already hold a link for, one of the two links is torn down
silently (it never produced an `onConnected`, so it produces no `onDisconnected`).

The tie-break has to be computed identically on both phones from information both
hold, or they discard opposite links and end up with none:

> the device with the lexicographically **smaller** tag keeps the link it
> **dialled out** on.

On the other phone that same wire is the inbound one, so both keep it.

A link that has not sent `HELLO` within 10 s is dropped. Android will only give
you a handful of concurrent GATT connections — typically around seven, after which
every `connectGatt` silently fails — so an unusable link is worse than none.

## API

```ts
import * as BleMesh from '../../modules/ble-mesh';

await BleMesh.startAdvertising(0);   // 0 = default 15-minute rotation
await BleMesh.startScanning();

const sub = BleMesh.addPeerFoundListener(({ id }) => BleMesh.connect(id));
```

| Function | Notes |
| --- | --- |
| `startAdvertising(rotationMs)` | Starts the GATT server, advertises, starts the rotation timer. `0` uses the default. **No display-name parameter, and there never will be one.** |
| `startScanning()` | Scans for the service UUID. |
| `stopAll()` | Stops both, tears down every link and every reassembly buffer, forgets the tag. Always resolves. |
| `connect(peerId)` | **Idempotent** — both phones call it about each other in the same few milliseconds. Resolves when issued, not when connected; wait for `onConnected`. |
| `disconnect(peerId)` | No-op success if already gone — safe in cleanup paths. |
| `send(peerId, payloadBase64)` | Whole payload; chunked natively. Resolves when the last chunk is handed to the OS, which is not delivery. |
| `getStatus()` | `{ state, available, message }` — distinguishes `poweredOff` from `unauthorized`. |
| `isAvailable()` | `getStatus().state === 'ready'`. |
| `rotateNow()` | Forces an immediate rotation. For panic wipe and tests. |

Events: `onPeerFound`, `onPeerLost`, `onConnected`, `onDisconnected`, `onPayload`,
`onStateChange`, `onError`. Each has a typed `add<Name>Listener(cb)` helper in
`src/BleMeshModule.ts`.

Every failure both **rejects the promise** and emits `onError` with the same
`code`/`message`, so a global error surface can observe failures without wrapping
every call. Error codes are shared verbatim between the two platforms
(`ERR_BLE_*`).

`onPeerFound` is emitted on first sighting and after a peer rotates — not on every
advertisement, which arrives several times a second.

`onPeerLost` is **advisory**: neither platform has a reliable "lost" callback, so
it is inferred from 30 s of silence. Treat it as "stop offering to connect", not
"gone". A connected peer never produces `onPeerLost`.

## You must rebuild the native app

This module ships native Swift and Kotlin. It cannot be picked up by a JS reload
or by Expo Go:

```sh
npx expo prebuild --clean
npx expo run:ios      # or: npx expo run:android
```

Metro-only restarts keep failing with `Cannot find native module 'BleMesh'`.

## Permissions

### Android

Declared in this module's `AndroidManifest.xml` and merged into the app.

| Permission | Applies to |
| --- | --- |
| `BLUETOOTH`, `BLUETOOTH_ADMIN` | API ≤ 30 only, install-time |
| `BLUETOOTH_SCAN` (`neverForLocation`), `BLUETOOTH_ADVERTISE`, `BLUETOOTH_CONNECT` | API 31+, runtime |
| `ACCESS_FINE_LOCATION` (`maxSdkVersion=30`) | API ≤ 30 only, runtime |

`BLUETOOTH_SCAN` is declared `neverForLocation`, and that is a real assertion: this
module never derives location from a scan result, never uses RSSI for ranging and
never persists a scan record. It means the app does **not** need
`ACCESS_FINE_LOCATION` on Android 12+ — one fewer permission to grant while
standing in a crowd, and one fewer capability an attacker who compromises the app
inherits.

On API ≤ 30 there is no such escape hatch: a BLE scan returns nothing without
location permission **and** with Location Services switched on at the OS level.

`startAdvertising` and `startScanning` request the API-appropriate runtime set
themselves and reject with `ERR_BLE_UNAUTHORIZED` naming exactly what was refused.

Note that `app.json` still lists the wider Nearby permission set, because
`modules/nearby-mesh` is still present. **Trim it when nearby-mesh is deleted** —
this transport needs none of `NEARBY_WIFI_DEVICES`, `ACCESS_WIFI_STATE`,
`CHANGE_WIFI_STATE` or unbounded location.

### iOS

`NSBluetoothAlwaysUsageDescription` is required and is set in `app.json` under
`expo.ios.infoPlist`. Without it the app is terminated on first Bluetooth use.

Both `CBCentralManager` and `CBPeripheralManager` are constructed lazily on the
first `start*` call, because constructing either is what triggers the permission
prompt and an app that has not yet asked to use the radio should not be prompting.

Background operation is **not** configured (no `UIBackgroundModes`). iOS suspends
BLE aggressively and background mesh relaying is open problem #4 in the threat
model; keep the app in the foreground.

## Platform semantics the TS layer must paper over

1. **`onPeerLost` is inferred, not reported.** CoreBluetooth has no lost callback
   and Android's scanner has no reliable one, so both platforms use a 30 s
   last-seen timer. iOS additionally has to scan with `allowDuplicates: true` to
   see the timer tick at all, which costs battery and is not optional.
2. **The MTU is not symmetric.** The write ceiling (central → peripheral) and the
   notification ceiling (peripheral → central) are different numbers on the same
   link, and each side frames using its own. `onConnected.mtu` is ours, for
   diagnostics only.
3. **`peerId` is per-role.** The two directions of a duplicate link get distinct
   handles until `HELLO` resolves them. Never assume one device is one `peerId`.
4. **Android must `close()` every `BluetoothGatt`.** An unclosed one leaks its
   binder and after a handful of them every subsequent `connectGatt` fails with
   status 133 until the app restarts. Handled here; mentioned because it is the
   single most common way an Android BLE app dies slowly.
5. **A `NOTIFY` characteristic needs an explicit CCCD on Android.** iOS adds it
   for you. A peer with no CCCD is dropped rather than kept as a write-only link —
   in an epidemic mesh we would relay into it forever and never learn what it
   carries.
6. **`stopAll()` synthesises disconnects.** Neither platform reliably fires
   per-link disconnect callbacks when the whole transport is torn down, so both
   emit `onDisconnected` themselves. Your handler must tolerate a disconnect for a
   peer it already forgot.
7. **Data before `HELLO` is dropped.** A frame that arrives on a link with no
   transport identity is discarded rather than emitted against a handle nobody has
   been told about.
8. **Unknown frame types are ignored, not fatal.** An old build has to stay usable
   in a mesh that contains newer ones.
