import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Profile } from '../../types/database';
import { theme } from '../../theme';

export type BarberMoreDestination = 'services' | 'availability' | 'loyalty' | 'businessProfile';
type IconName = keyof typeof MaterialCommunityIcons.glyphMap;

const rows: { key: BarberMoreDestination; icon: IconName; title: string; detail: string }[] = [
  { key: 'services', icon: 'content-cut', title: 'Services', detail: 'Prices, durations and return intervals' },
  { key: 'availability', icon: 'calendar-clock-outline', title: 'Availability', detail: 'Working hours and time off' },
  { key: 'loyalty', icon: 'diamond-stone', title: 'Loyalty & rewards', detail: 'Configure customer rewards' },
  { key: 'businessProfile', icon: 'storefront-outline', title: 'Business profile', detail: 'Your barber and business details' },
];

export function BarberMore({ profile, busy, onOpen, onSignOut }: { profile: Profile; busy: boolean; onOpen: (destination: BarberMoreDestination) => void; onSignOut: () => void }) {
  const initials = profile.full_name.split(' ').map(x => x[0]).slice(0, 2).join('');
  return <View style={s.page}>
    <View style={s.header}>{profile.avatar_url ? <Image source={{ uri: profile.avatar_url }} style={s.avatar} /> : <View style={s.fallback}><Text style={s.initials}>{initials}</Text></View>}<View style={s.flex}><Text style={s.overline}>BARBER SETTINGS</Text><Text style={s.title}>More</Text><Text style={s.detail}>{profile.display_name || profile.full_name}</Text></View></View>
    <View style={s.list}>{rows.map(row => <Pressable key={row.key} onPress={() => onOpen(row.key)} style={({ pressed }) => [s.row, pressed && s.pressed]}><View style={s.iconBox}><MaterialCommunityIcons name={row.icon} size={20} color={theme.colors.cognacPressed} /></View><View style={s.flex}><Text style={s.rowTitle}>{row.title}</Text><Text style={s.detail}>{row.detail}</Text></View><MaterialCommunityIcons name="chevron-right" size={22} color={theme.colors.muted} /></Pressable>)}</View>
    <Pressable disabled={busy} onPress={onSignOut} style={({ pressed }) => [s.signOut, pressed && s.pressed, busy && s.disabled]}><Text style={s.signOutText}>{busy ? 'Signing out…' : 'Sign out'}</Text></Pressable>
  </View>;
}

const s = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingTop: 12, gap: 20 },
  header: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 11 },
  avatar: { width: 44, height: 44, borderRadius: 22 }, fallback: { width: 44, height: 44, borderRadius: 22, backgroundColor: '#F1E4D7', alignItems: 'center', justifyContent: 'center' }, initials: { color: theme.colors.cognacPressed, fontFamily: theme.fonts.bold, fontSize: 13 },
  flex: { flex: 1 }, overline: { color: theme.colors.cognacPressed, fontSize: 10, lineHeight: 13, fontFamily: theme.fonts.bold, letterSpacing: .8 }, title: { color: theme.colors.primary, fontSize: 24, lineHeight: 29, fontFamily: theme.fonts.bold },
  list: { backgroundColor: theme.colors.card, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radii.card, overflow: 'hidden', ...theme.shadow },
  row: { minHeight: 70, paddingHorizontal: 14, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', gap: 11, borderBottomWidth: 1, borderBottomColor: theme.colors.border }, pressed: { backgroundColor: theme.colors.cardMuted },
  iconBox: { width: 38, height: 38, borderRadius: 11, backgroundColor: '#F4E8DC', alignItems: 'center', justifyContent: 'center' }, rowTitle: { color: theme.colors.primary, fontSize: 15, lineHeight: 19, fontFamily: theme.fonts.bold }, detail: { color: theme.colors.secondary, fontSize: 12, lineHeight: 17, fontFamily: theme.fonts.regular, marginTop: 1 },
  signOut: { minHeight: 46, borderRadius: theme.radii.input, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.card, alignItems: 'center', justifyContent: 'center' }, signOutText: { color: '#B42318', fontFamily: theme.fonts.bold, fontSize: 13 }, disabled: { opacity: .55 },
});
