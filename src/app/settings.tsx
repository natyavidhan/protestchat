/**
 * Settings, and the honest-limitations notice.
 *
 * That notice is not boilerplate and should not be moved, shortened, collapsed,
 * or hidden behind a link. People make decisions about their physical safety
 * based on whether they believe this app works. They are entitled to know
 * exactly what it does not do, in the app, before they need it.
 *
 * It is deliberately the largest block on this screen and set at reading size
 * rather than fine-print size. Small grey text at the bottom of a settings
 * screen is the universal visual grammar for "nobody is expected to read this",
 * and this is the one thing here that everybody should.
 */

import { Stack } from 'expo-router';
import { useState } from 'react';
import { Alert, StyleSheet, Switch, Text, View } from 'react-native';

import { Bullets, Button, Card, Field, Input, Notice, Screen, Tag } from '@/components/ui';
import { Spacing, TAP_TARGET, Type } from '@/constants/theme';
import { useTheme } from '@/hooks/use-theme';
import { useApp } from '@/lib/app-state';

const LIMITATIONS = [
  'Your phone being taken while unlocked. Anyone holding it reads everything.',
  'Being physically located. Bluetooth is a radio; anyone with the right equipment can tell that a phone here is transmitting, even though they cannot read it.',
  'Someone standing next to you reading your screen.',
  'A contact you never verified in person turning out to be someone else.',
];

export default function SettingsScreen() {
  const t = useTheme();
  const { displayName, setDisplayName, status, startRadio, stopRadio, panicWipe } = useApp();
  const [name, setName] = useState(displayName);

  const confirmWipe = () =>
    Alert.alert(
      'Delete everything?',
      'Every message, every contact and your identity are erased from this phone. This cannot be undone, and the people you talked to will not be notified.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete everything', style: 'destructive', onPress: () => void panicWipe() },
      ],
    );

  return (
    <Screen contentStyle={{ gap: Spacing.xl }}>
      <Stack.Screen options={{ title: 'Settings' }} />

      <Card style={{ gap: Spacing.lg }}>
        <Field
          label="Name others see nearby"
          hint="This is broadcast in the clear to every phone in range, contact or not. Do not use your real name.">
          <Input value={name} onChangeText={setName} placeholder="anon" maxLength={32} />
        </Field>
        <Button
          title="Save"
          variant="secondary"
          onPress={() => void setDisplayName(name)}
          disabled={name.trim() === displayName}
        />
      </Card>

      <Card>
        <View style={styles.switchRow}>
          <View style={{ flex: 1, gap: Spacing.xs }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: Spacing.md }}>
              <Text style={[Type.bodyStrong, { color: t.text }]}>Mesh radio</Text>
              {/* The word, not just the switch position: a switch read at a
                  glance in bright sun is two grey rectangles. */}
              <Tag tone={status.running ? 'ok' : 'danger'} label={status.running ? 'On' : 'Off'} />
            </View>
            <Text style={[Type.callout, { color: t.textMuted }]}>
              {status.running
                ? 'Reachable, and relaying sealed messages for people you will never meet.'
                : 'Nothing in, nothing out. You are also not relaying for anyone else.'}
            </Text>
          </View>
          <Switch
            value={status.running}
            onValueChange={(on) => void (on ? startRadio() : stopRadio())}
            accessibilityLabel="Mesh radio"
          />
        </View>
      </Card>

      <Notice tone="danger" title="Panic wipe">
        <Text style={[Type.callout, { color: t.text }]}>
          Erases every message, contact and key on this phone immediately, and gives you a fresh
          identity. There is no undo and no backup.
        </Text>
        <Button
          title="Delete everything"
          variant="danger"
          onPress={confirmWipe}
          style={{ marginTop: Spacing.sm }}
        />
      </Notice>

      <View style={[styles.honest, { borderColor: t.border }]}>
        <Text accessibilityRole="header" style={[Type.title, { color: t.text }]}>
          What this does not protect you from
        </Text>
        <Bullets items={LIMITATIONS} />
        <Text style={[Type.callout, { color: t.textMuted }]}>
          This software has not been independently audited. Treat it as useful, not as guaranteed.
          If your safety depends on it, assume a determined state adversary can still learn that
          you were present and transmitting.
        </Text>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.lg,
    minHeight: TAP_TARGET - Spacing.lg,
  },
  honest: {
    gap: Spacing.lg,
    paddingTop: Spacing.xl,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
