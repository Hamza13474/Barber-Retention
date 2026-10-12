import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

export type BarberTab = 'dashboard' | 'calendar' | 'customers' | 'more';
export type CustomerTab = 'home' | 'book' | 'rewards' | 'appointments' | 'profile';

type IconName = keyof typeof MaterialCommunityIcons.glyphMap;
const barberTabs: { key: BarberTab; label: string; icon: IconName; activeIcon: IconName }[] = [
  { key: 'dashboard', label: 'Dashboard', icon: 'view-dashboard-outline', activeIcon: 'view-dashboard' },
  { key: 'calendar', label: 'Calendar', icon: 'calendar-month-outline', activeIcon: 'calendar-month' },
  { key: 'customers', label: 'Customers', icon: 'account-group-outline', activeIcon: 'account-group' },
  { key: 'more', label: 'More', icon: 'dots-horizontal', activeIcon: 'dots-horizontal' },
];

const customerTabs: { key: CustomerTab; label: string; icon: IconName; activeIcon: IconName }[] = [
  { key: 'home', label: 'Home', icon: 'home-outline', activeIcon: 'home' },
  { key: 'book', label: 'Book', icon: 'calendar-plus-outline', activeIcon: 'calendar-plus' },
  { key: 'rewards', label: 'Rewards', icon: 'tag-heart-outline', activeIcon: 'tag-heart' },
  { key: 'appointments', label: 'Appointments', icon: 'calendar-text-outline', activeIcon: 'calendar-text' },
  { key: 'profile', label: 'Profile', icon: 'account-outline', activeIcon: 'account' },
];

type Props =
  | { role?: 'barber'; active: BarberTab; onChange: (tab: BarberTab) => void }
  | { role: 'customer'; active: CustomerTab; onChange: (tab: CustomerTab) => void };

export function BottomTabBar(props: Props) {
  const customer = props.role === 'customer';
  const tabs = customer ? customerTabs : barberTabs;
  return <View style={[s.bar, customer && s.customerBar]} accessibilityRole="tablist">{tabs.map(tab => {
    const selected = tab.key === props.active;
    return <Pressable key={tab.key} accessibilityRole="tab" accessibilityLabel={tab.label} accessibilityState={{ selected }} onPress={() => (props.onChange as (key: typeof tab.key) => void)(tab.key)} style={({ pressed }) => [s.item, customer && s.customerItem, pressed && s.pressed]}>
      <MaterialCommunityIcons name={selected ? tab.activeIcon : tab.icon} size={customer ? 22 : theme.nav.icon} color={selected ? theme.colors.primary : theme.colors.muted} />
      <Text numberOfLines={1} adjustsFontSizeToFit={customer} minimumFontScale={0.88} style={[s.label, customer && s.customerLabel, selected && s.active]}>{tab.label}</Text>
      <View style={[s.indicator, selected && s.indicatorOn]} />
    </Pressable>;
  })}</View>;
}

const s = StyleSheet.create({
  bar: { height: theme.nav.height, flexDirection: 'row', backgroundColor: theme.colors.card, borderTopWidth: 1, borderTopColor: theme.colors.border, ...theme.shadow },
  customerBar: { height: 62 },
  item: { flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', paddingTop: 5 },
  customerItem: { minWidth: 0, paddingHorizontal: 1, paddingTop: 4 },
  pressed: { backgroundColor: theme.colors.cardMuted },
  label: { color: '#77777F', fontSize: theme.type.label, lineHeight: 14, fontFamily: theme.fonts.medium, marginTop: 1 },
  customerLabel: { width: '100%', paddingHorizontal: 1, fontSize: 10.5, lineHeight: 13, textAlign: 'center' },
  active: { color: theme.colors.primary, fontFamily: theme.fonts.bold },
  indicator: { width: theme.nav.indicatorWidth, height: theme.nav.indicatorHeight, borderRadius: theme.radii.pill, marginTop: 3, backgroundColor: 'transparent' },
  indicatorOn: { backgroundColor: theme.colors.cognac },
});
