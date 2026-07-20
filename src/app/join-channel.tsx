/**
 * Joining a channel.
 *
 * Key derivation is intentionally slow, so this screen shows real progress
 * rather than appearing frozen. The delay is a feature and is explained, not
 * apologised for.
 *
 * The three-line warning below the form is not fine print. A channel is the
 * only mode here whose confidentiality depends on something a human chose under
 * pressure, and "gate4 / delhi" shouted across a crowd is the realistic case.
 */

import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';

import { Bullets, Button, Card, Field, Input, Notice, Screen } from '@/components/ui';
import { Spacing, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useApp } from '@/lib/app-state';

const CAVEATS = [
  'Anyone with the passphrase reads everything, including messages sent before they joined.',
  'You cannot remove anyone. There is no owner and no admin — if the passphrase leaks, the channel is finished and you start a new one with a new passphrase.',
  'A short passphrase like “delhi” can be guessed later by someone who recorded the Bluetooth traffic tonight. Use several unrelated words.',
];

export default function JoinChannelScreen() {
  const t = useTheme();
  const router = useRouter();
  const { joinChannel } = useApp();

  const [name, setName] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onJoin = async () => {
    setBusy(true);
    setError(null);
    try {
      // Yield a frame first so the spinner actually paints before scrypt takes
      // over the JS thread — otherwise the UI just freezes for a beat.
      await new Promise((r) => setTimeout(r, 32));
      const channel = await joinChannel(name, passphrase);
      router.replace(`/chat/${encodeURIComponent(`#${channel.id}`)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not join.');
      setBusy(false);
    }
  };

  return (
    <Screen contentStyle={{ gap: Spacing.xl }}>
      <View style={{ gap: Spacing.sm }}>
        <Text style={[Type.hero, { color: t.text }]}>Join a channel</Text>
        <Text style={[Type.body, { color: t.textMuted }]}>
          Everyone who wants to read this types the same two things. There is no invite and no
          owner — the passphrase is the only thing that grants access.
        </Text>
      </View>

      <Card style={{ gap: Spacing.lg }}>
        <Field label="Channel name">
          <Input value={name} onChangeText={setName} placeholder="gate4" autoFocus />
        </Field>

        <Field label="Passphrase">
          <Input
            value={passphrase}
            onChangeText={setPassphrase}
            placeholder="Several unrelated words"
            secureTextEntry
          />
        </Field>

        {!!error && (
          <Text accessibilityRole="alert" style={[Type.callout, { color: t.tone.danger.fg }]}>
            {error}
          </Text>
        )}

        {busy ? (
          <View
            accessibilityRole="progressbar"
            style={{ alignItems: 'center', gap: Spacing.md, paddingVertical: Spacing.lg }}>
            <ActivityIndicator color={t.accent} />
            <Text style={[Type.callout, { color: t.textMuted, textAlign: 'center' }]}>
              Scrambling the passphrase. This is slow on purpose — the same slowness is what makes
              it expensive to guess.
            </Text>
          </View>
        ) : (
          <Button title="Join channel" onPress={onJoin} disabled={!name.trim() || !passphrase} />
        )}
      </Card>

      <Notice tone="caution" title="Before you use this">
        <Bullets items={CAVEATS} color={t.text} />
      </Notice>
    </Screen>
  );
}
