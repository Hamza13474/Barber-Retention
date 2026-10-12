import { Platform } from 'react-native';

export const theme = {
  colors: {
    canvas: '#F3F4F6',
    card: '#FFFFFF',
    cardMuted: '#F8F9FA',
    primary: '#181A1E',
    secondary: '#52525B',
    muted: '#A1A1AA',
    border: '#E5E7EB',
    cognac: '#C67D3B',
    cognacPressed: '#A85A1C',
    active: { text: '#16A34A', background: '#DCFCE7', border: '#BBF7D0' },
    dueSoon: { text: '#854D0E', background: '#FEFCE8', border: '#FEF08A', dot: '#CA8A04' },
    overdue: { text: '#9A3412', background: '#FFF7ED', border: '#FED7AA', dot: '#EA580C' },
    atRisk: { text: '#991B1B', background: '#FEF2F2', border: '#FECACA', dot: '#DC2626' },
    booked: { text: '#0F766E', background: '#CCFBF1', border: '#99F6E4' },
  },
  spacing: { xs: 4, sm: 8, md: 16, lg: 24, xl: 32 },
  radii: { sm: 4, md: 8, input: 12, card: 16, xl: 24, pill: 999 },
  type: {
    display: 28,
    title: 22,
    section: 20,
    cardTitle: 17,
    body: 14,
    small: 13,
    label: 11,
  },
  fonts: {
    regular: 'PlusJakartaSans_400Regular',
    medium: 'PlusJakartaSans_500Medium',
    semibold: 'PlusJakartaSans_600SemiBold',
    bold: 'PlusJakartaSans_700Bold',
  },
  nav: { height: 64, icon: 23, indicatorWidth: 20, indicatorHeight: 4 },
  shadow: Platform.select({
    ios: { shadowColor: '#181A1E', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.08, shadowRadius: 10 },
    android: { elevation: 3 },
    default: {},
  }),
} as const;
