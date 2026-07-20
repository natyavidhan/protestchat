/**
 * Transport abstraction.
 *
 * The mesh engine talks to this, never to the native module directly. Two
 * reasons, both of which matter more than the indirection costs:
 *
 *   1. The radio is going to change. Our own BLE GATT transport is v1; LoRa,
 *      Wi-Fi Aware, or an internet gateway for peers who have walked out of the
 *      jammed zone all plug in behind this same interface. Google Nearby was
 *      v0 and was removed — see getTransport() for why.
 *   2. No native radio exists in Expo Go or on web. Without a stub, the whole
 *      app becomes untestable except on a custom dev build wired to a phone.
 */

import { Platform } from 'react-native';

export type Peer = { id: string; name: string };

export type TransportEvents = {
  peerFound: (peer: Peer) => void;
  peerLost: (peerId: string) => void;
  connected: (peer: Peer) => void;
  disconnected: (peerId: string) => void;
  payload: (peerId: string, payloadBase64: string) => void;
  error: (message: string) => void;
};

export interface Transport {
  readonly available: boolean;
  start(serviceId: string, displayName: string): Promise<void>;
  stop(): Promise<void>;
  send(peerId: string, payloadBase64: string): Promise<void>;
  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void;
}

// ---------------------------------------------------------------------------
// Shared listener bookkeeping
// ---------------------------------------------------------------------------

class Emitter {
  private handlers: { [K in keyof TransportEvents]?: Set<TransportEvents[K]> } = {};

  on<K extends keyof TransportEvents>(event: K, handler: TransportEvents[K]): () => void {
    const set = (this.handlers[event] ??= new Set() as any) as Set<TransportEvents[K]>;
    set.add(handler);
    return () => set.delete(handler);
  }

  emit<K extends keyof TransportEvents>(event: K, ...args: Parameters<TransportEvents[K]>): void {
    for (const h of this.handlers[event] ?? []) {
      try {
        (h as (...a: any[]) => void)(...args);
      } catch (err) {
        // A throwing listener must never take down the radio loop.
        console.warn(`[transport] listener for "${event}" threw:`, err);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// BLE-backed transport (modules/ble-mesh)
// ---------------------------------------------------------------------------

/**
 * Our own CoreBluetooth / Android-GATT transport.
 *
 * Preferred over Nearby for two reasons that both bite at a protest:
 *
 *   1. Nearby on iOS only ever brings up the Wi-Fi LAN medium, so both phones
 *      have to already be on the same Wi-Fi network. In a jammed square with no
 *      infrastructure that is not a degraded path, it is no path at all.
 *   2. Nearby gives no control over its advertising identifier. A stable BLE
 *      identifier is a tracking beacon — open problem #2 in the threat model.
 *      Owning the advertisement is the only way to rotate it.
 */
class BleTransport implements Transport {
  readonly available = true;
  private emitter = new Emitter();
  private subscriptions: { remove(): void }[] = [];
  private running = false;

  constructor(private native: any) {}

  on = <K extends keyof TransportEvents>(e: K, h: TransportEvents[K]) => this.emitter.on(e, h);
  private emit = <K extends keyof TransportEvents>(e: K, ...a: Parameters<TransportEvents[K]>) =>
    this.emitter.emit(e, ...a);

  /**
   * `serviceId` and `displayName` are both accepted and both deliberately
   * unused, because the `Transport` interface is shared with Nearby.
   *
   *   - `serviceId` has no BLE equivalent. A GATT service is a 128-bit UUID, not
   *     an arbitrary string, and ours is a fixed constant in the module.
   *   - `displayName` is NEVER advertised, and this is a security requirement
   *     rather than an omission. Anything put in a BLE advertisement is readable
   *     by every radio in range including a police scanner, and a name a person
   *     chose for themselves is exactly the kind of thing that survives a
   *     rotation and links a body to a device. Peer identity is established by
   *     the sealed payloads at the mesh layer; this transport deals only in
   *     ephemeral per-session handles.
   */
  async start(_serviceId: string, _displayName: string): Promise<void> {
    if (this.running) return;
    this.running = true;

    const n = this.native;
    this.subscriptions = [
      // Connections are dialled and accepted unconditionally. This looks alarming
      // and is not: the mesh is a public medium by construction, a relay cannot
      // prompt a human for every stranger it forwards through, and refusing
      // connections would only shrink the network without protecting anything.
      // Confidentiality and authenticity come from the sealed payload (see
      // crypto.ts), never from who we agreed to shake hands with.
      //
      // The native side makes `connect` idempotent precisely because both phones
      // reach this line about each other within the same few milliseconds.
      n.addPeerFoundListener((p: { id: string }) => {
        this.emit('peerFound', { id: p.id, name: '' });
        n.connect(p.id).catch(() => {
          // A peer that walked out of range between the advertisement and the
          // connection attempt is the normal case in a moving crowd, not an
          // error worth putting in front of someone.
        });
      }),
      n.addPeerLostListener((p: { id: string }) => this.emit('peerLost', p.id)),
      n.addConnectedListener((p: { id: string }) => this.emit('connected', { id: p.id, name: '' })),
      n.addDisconnectedListener((p: { id: string }) => this.emit('disconnected', p.id)),
      n.addPayloadListener((p: { peerId: string; payloadBase64: string }) =>
        this.emit('payload', p.peerId, p.payloadBase64),
      ),
      // "Bluetooth is off" and "you denied the permission" need completely
      // different instructions, so the native layer keeps them distinct and the
      // message it hands up is already the one to show a user.
      //
      // 'unknown' and 'resetting' are transient — the radio reports 'unknown'
      // for a moment at startup before it has read its own state, and briefly
      // 'resetting' when it cycles. Neither is something a user can act on, so
      // surfacing them just pins a scary line ("Bluetooth state is not known
      // yet") on the screen that never clears, even once connected. Only the
      // genuinely actionable bad states are shown; reaching 'ready' clears
      // whatever was shown (empty string is the clear signal — see mesh.ts).
      n.addStateChangeListener((s: { state: string; message: string }) => {
        if (s.state === 'ready') {
          this.emit('error', '');
        } else if (s.state === 'poweredOff' || s.state === 'unauthorized' || s.state === 'unsupported') {
          this.emit('error', s.message);
        }
      }),
      n.addErrorListener((p: { message: string }) => this.emit('error', p.message)),
    ];

    // Advertise and scan simultaneously: every device is both a GATT peripheral
    // and a GATT central, because there is no host role in a mesh. 0 means "use
    // the module's 15-minute identifier rotation default".
    await n.startAdvertising(0);
    await n.startScanning();
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    for (const s of this.subscriptions) s.remove();
    this.subscriptions = [];
    await this.native.stopAll();
  }

  send(peerId: string, payloadBase64: string): Promise<void> {
    // Chunking to the negotiated MTU happens natively, below this call. See
    // modules/ble-mesh/README.md for why it lives there and not here.
    return this.native.send(peerId, payloadBase64);
  }
}

// ---------------------------------------------------------------------------
// Stub transport (web, Expo Go, simulator without the native module)
// ---------------------------------------------------------------------------

class UnavailableTransport implements Transport {
  readonly available = false;
  private emitter = new Emitter();

  on = <K extends keyof TransportEvents>(e: K, h: TransportEvents[K]) => this.emitter.on(e, h);

  async start(): Promise<void> {
    this.emitter.emit(
      'error',
      Platform.OS === 'web'
        ? 'Radio unavailable in a browser. Install the app on a phone.'
        : 'Radio unavailable. This build is missing the native mesh module — run `npx expo run:ios` or `npx expo run:android`.',
    );
  }

  async stop(): Promise<void> {}

  async send(): Promise<void> {
    throw new Error('transport unavailable');
  }
}

// ---------------------------------------------------------------------------

let cached: Transport | null = null;

/**
 * Requires a local native module and returns its whole namespace, or null.
 *
 * Defensive and lazy: on web and in Expo Go the `requireNativeModule` call
 * inside each of these throws at import time, and that is an expected,
 * recoverable state rather than a crash — the app must still launch and show its
 * "no radio" state.
 *
 * The *namespace* rather than the default export, because the typed
 * `add*Listener` helpers are named exports; the default export is the bare
 * native module and has no listener helpers on it.
 */
function loadModule(load: () => any): any | null {
  try {
    return load() ?? null;
  } catch {
    return null;
  }
}

export function getTransport(): Transport {
  if (cached) return cached;

  // ble-mesh or nothing. nearby-mesh has been deleted: Nearby on iOS only ever
  // brings up the Wi-Fi LAN medium, which is no path at all in a jammed square
  // with no infrastructure, and it gave us no control over the advertising
  // identifier. Keeping it as a fallback also meant two native modules
  // declaring conflicting ACCESS_FINE_LOCATION bounds, which broke the Android
  // manifest merge outright.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const ble = loadModule(() => require('../../modules/ble-mesh'));
  cached =
    ble && typeof ble.startAdvertising === 'function' && typeof ble.startScanning === 'function'
      ? new BleTransport(ble)
      : new UnavailableTransport();

  return cached;
}
