import { StyleSheet, Text, View } from 'react-native';
import type { RetentionActionableStatus } from '../types/database';
import { theme } from '../theme';

const stylesByStatus = {
  ACTIVE: theme.colors.active,
  DUE_SOON: theme.colors.dueSoon,
  OVERDUE: theme.colors.overdue,
  AT_RISK: theme.colors.atRisk,
  BOOKED: theme.colors.booked,
};
const labels: Record<RetentionActionableStatus, string> = { ACTIVE: 'ACTIVE', DUE_SOON: 'DUE SOON', OVERDUE: 'OVERDUE', AT_RISK: 'AT RISK', BOOKED: 'BOOKED' };

export function StatusBadge({ status }: { status: RetentionActionableStatus }) {
  const colors = stylesByStatus[status];
  const dot = 'dot' in colors ? colors.dot : colors.text;
  return <View style={[s.badge, { backgroundColor: colors.background, borderColor: colors.border }]}><View style={[s.dot, { backgroundColor: dot }]} /><Text style={[s.text, { color: colors.text }]}>{labels[status]}</Text></View>;
}

const s = StyleSheet.create({
  badge: { minHeight: 24, borderRadius: theme.radii.pill, borderWidth: 1, paddingHorizontal: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  text: { fontSize: theme.type.label, lineHeight: 14, fontFamily: theme.fonts.bold, letterSpacing: .35 },
});
