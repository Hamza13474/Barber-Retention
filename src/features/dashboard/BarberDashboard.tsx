import { useCallback, useEffect, useMemo, useState } from 'react';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { StatusBadge } from '../../components/StatusBadge';
import { supabase } from '../../lib/supabase';
import { theme } from '../../theme';
import type { AppointmentStatus, BarberRetentionCustomer, CalendarAppointment, Profile, RetentionActionableStatus } from '../../types/database';

const attentionOrder: RetentionActionableStatus[] = ['AT_RISK', 'OVERDUE', 'DUE_SOON'];
const appointmentLabels: Record<AppointmentStatus, string> = { booked: 'Booked', completed: 'Completed', no_show: 'No-show', cancelled_by_customer: 'Cancelled', cancelled_by_barber: 'Cancelled' };
const pad = (value: number) => String(value).padStart(2, '0');
const localParts = (instant: Date, timezone: string) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
const localDate = (instant: Date, timezone: string) => { const p = localParts(instant, timezone); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; };
const shiftDate = (date: string, days: number) => { const [y, m, d] = date.split('-').map(Number); const value = new Date(Date.UTC(y, m - 1, d + days, 12)); return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`; };
const monthStart = (date: string, offset = 0) => { const [y, m] = date.split('-').map(Number); const value = new Date(Date.UTC(y, m - 1 + offset, 1, 12)); return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-01`; };
const zonedBoundary = (date: string, timezone: string) => { const [year, month, day] = date.split('-').map(Number); const desired = Date.UTC(year, month - 1, day); let value = desired; for (let i = 0; i < 3; i += 1) { const p = localParts(new Date(value), timezone); value += desired - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second); } return new Date(value).toISOString(); };
const dateOnly = (value: string) => { const [year, month, day] = value.split('-').map(Number); return new Date(year, month - 1, day, 12).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); };
const money = (value: number) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 }).format(value);

type LoadErrors = { retention: boolean; calendar: boolean; registeredCustomers: boolean; completedValue: boolean; upcoming: boolean };
const noErrors: LoadErrors = { retention: false, calendar: false, registeredCustomers: false, completedValue: false, upcoming: false };

export function BarberDashboard({ profile, onOpenRetention, onOpenCustomer, onOpenCalendar }: { profile: Profile; onOpenRetention: () => void; onOpenCustomer: (customerId: string) => void; onOpenCalendar: () => void }) {
  const timezone = profile.timezone || 'Europe/London';
  const today = localDate(new Date(), timezone);
  const [customers, setCustomers] = useState<BarberRetentionCustomer[]>([]);
  const [appointments, setAppointments] = useState<CalendarAppointment[]>([]);
  const [registeredCustomers, setRegisteredCustomers] = useState<number | null>(null);
  const [completedValue, setCompletedValue] = useState<number | null>(null);
  const [upcomingBookings, setUpcomingBookings] = useState<number | null>(null);
  const [errors, setErrors] = useState<LoadErrors>(noErrors);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setErrors(noErrors);
    const todayFrom = zonedBoundary(today, timezone);
    const todayTo = zonedBoundary(shiftDate(today, 1), timezone);
    const monthFrom = zonedBoundary(monthStart(today), timezone);
    const monthTo = zonedBoundary(monthStart(today, 1), timezone);
    const [retention, calendar, registered, completed, upcoming] = await Promise.all([
      supabase!.rpc('get_barber_retention_dashboard'),
      supabase!.rpc('get_barber_calendar', { p_from: todayFrom, p_to: todayTo }),
      supabase!.rpc('get_barber_registered_customer_count'),
      supabase!.from('appointments').select('estimated_total').eq('barber_id', profile.id).eq('status', 'completed').gte('completed_at', monthFrom).lt('completed_at', monthTo),
      supabase!.from('appointments').select('id', { count: 'exact', head: true }).eq('barber_id', profile.id).eq('status', 'booked').gt('start_at', new Date().toISOString()),
    ]);
    const nextErrors = { retention: !!retention.error, calendar: !!calendar.error, registeredCustomers: !!registered.error, completedValue: !!completed.error, upcoming: !!upcoming.error };
    setErrors(nextErrors);
    if (retention.error) setCustomers([]); else setCustomers((retention.data ?? []) as BarberRetentionCustomer[]);
    if (calendar.error) setAppointments([]); else setAppointments((calendar.data ?? []) as CalendarAppointment[]);
    if (registered.error) setRegisteredCustomers(null); else setRegisteredCustomers(Number(registered.data));
    if (completed.error) setCompletedValue(null); else setCompletedValue((completed.data ?? []).reduce((total, row) => total + Number(row.estimated_total ?? 0), 0));
    if (upcoming.error) setUpcomingBookings(null); else setUpcomingBookings(upcoming.count ?? 0);
    setLoading(false);
  }, [profile.id, timezone, today]);
  useEffect(() => { void load(); }, [load]);

  const todayAppointments = useMemo(() => appointments.filter(item => !item.status.startsWith('cancelled')), [appointments]);
  const counts = useMemo(() => ({
    DUE_SOON: customers.filter(item => item.actionable_status === 'DUE_SOON').length,
    OVERDUE: customers.filter(item => item.actionable_status === 'OVERDUE').length,
    AT_RISK: customers.filter(item => item.actionable_status === 'AT_RISK').length,
  }), [customers]);
  const attention = useMemo(() => customers.filter(item => item.actionable_status && attentionOrder.includes(item.actionable_status)).sort((a, b) => attentionOrder.indexOf(a.actionable_status!) - attentionOrder.indexOf(b.actionable_status!)), [customers]);
  const initials = profile.full_name.split(' ').map(part => part[0]).slice(0, 2).join('');
  const business = profile.display_name || profile.full_name;
  const currentDate = new Date().toLocaleDateString('en-GB', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long' });

  return <View style={s.page}>
    <View style={s.header}>
      {profile.avatar_url ? <Image source={{ uri: profile.avatar_url }} style={s.avatar} /> : <View style={s.avatarFallback}><Text style={s.avatarInitials}>{initials}</Text></View>}
      <View style={s.flex}><Text style={s.business} numberOfLines={1}>{business}</Text><Text style={s.date}>{currentDate}</Text></View>
      <Pressable accessibilityLabel="Refresh dashboard" onPress={() => void load()} style={({ pressed }) => [s.iconButton, pressed && s.pressed]}><MaterialCommunityIcons name="autorenew" size={21} color={theme.colors.cognacPressed} /></Pressable>
    </View>

    <View style={s.metricGrid}>
      <MetricCard icon="calendar-today" value={errors.calendar ? null : loading ? undefined : todayAppointments.length} label="Today's appointments" note="Today" />
      <MetricCard icon="account-group-outline" value={errors.registeredCustomers ? null : loading ? undefined : registeredCustomers ?? 0} label="Registered customers" note="Customer profiles" />
      <MetricCard icon="cash-check" value={errors.completedValue ? null : loading ? undefined : money(completedValue ?? 0)} label="Completed value" note="This month" />
      <MetricCard icon="calendar-clock-outline" value={errors.upcoming ? null : loading ? undefined : upcomingBookings ?? 0} label="Upcoming bookings" note="Future booked appointments" />
    </View>

    <View style={s.card}>
      <View style={s.sectionTop}><View><Text style={s.sectionTitle}>Retention</Text><Text style={s.support}>Customers in their return window</Text></View><Pressable onPress={onOpenRetention} style={s.textAction}><Text style={s.actionText}>View all</Text><MaterialCommunityIcons name="chevron-right" size={18} color={theme.colors.cognacPressed} /></Pressable></View>
      {loading ? <SectionLoader /> : errors.retention ? <InlineError onRetry={load} /> : <View style={s.retentionRows}>
        <RetentionRow label="Due Soon" value={counts.DUE_SOON} color={theme.colors.dueSoon.dot || theme.colors.dueSoon.text} />
        <RetentionRow label="Overdue" value={counts.OVERDUE} color={theme.colors.overdue.dot || theme.colors.overdue.text} />
        <RetentionRow label="At Risk" value={counts.AT_RISK} color={theme.colors.atRisk.dot || theme.colors.atRisk.text} />
      </View>}
    </View>

    <View style={s.sectionTop}><View><Text style={s.sectionTitle}>Needs attention</Text><Text style={s.support}>Prioritised from retention status</Text></View>{!errors.retention && attention.length > 3 && <Pressable onPress={onOpenRetention} style={s.textAction}><Text style={s.actionText}>View all</Text><MaterialCommunityIcons name="chevron-right" size={18} color={theme.colors.cognacPressed} /></Pressable>}</View>
    {loading ? <SectionLoader card /> : errors.retention ? <InlineError onRetry={load} /> : attention.length === 0 ? <Empty title={customers.length ? 'Everyone is on track.' : 'No completed customer history yet.'} detail={customers.length ? 'No customers need retention attention right now.' : 'Retention insights appear after completed visits.'} /> : attention.slice(0, 3).map(customer => <AttentionRow key={customer.customer_id} customer={customer} onPress={() => onOpenCustomer(customer.customer_id)} />)}

    <View style={s.sectionTop}><View><Text style={s.sectionTitle}>Today's appointments</Text><Text style={s.support}>A quick look at your day</Text></View><Pressable onPress={onOpenCalendar} style={s.textAction}><Text style={s.actionText}>View calendar</Text><MaterialCommunityIcons name="arrow-right" size={17} color={theme.colors.cognacPressed} /></Pressable></View>
    {loading ? <SectionLoader card /> : errors.calendar ? <InlineError onRetry={load} /> : todayAppointments.length === 0 ? <Empty title="No appointments today." detail="Your schedule is clear." /> : <View style={s.appointmentCard}>{todayAppointments.slice(0, 3).map(item => <AppointmentRow key={item.id} item={item} timezone={timezone} />)}</View>}
  </View>;
}

function MetricCard({ icon, value, label, note }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; value: string | number | null | undefined; label: string; note: string }) {
  return <View style={s.metricCard}><View style={s.metricIcon}><MaterialCommunityIcons name={icon} size={18} color={theme.colors.cognacPressed} /></View>{value === undefined ? <ActivityIndicator style={s.metricLoader} color={theme.colors.cognac} /> : <Text style={[s.metricValue, typeof value === 'string' && value.length > 7 && s.metricValueSmall]} numberOfLines={1}>{value === null ? '—' : value}</Text>}<Text style={s.metricLabel} numberOfLines={2}>{label}</Text><Text style={s.metricNote}>{value === null ? 'Unavailable' : note}</Text></View>;
}
function RetentionRow({ label, value, color }: { label: string; value: number; color: string }) { return <View style={s.retentionRow}><View style={[s.dot, { backgroundColor: color }]} /><Text style={s.retentionLabel}>{label}</Text><Text style={s.retentionValue}>{value}</Text></View>; }
function SectionLoader({ card = false }: { card?: boolean }) { return <View style={[s.loader, card && s.card]}><ActivityIndicator color={theme.colors.cognac} /></View>; }
function InlineError({ onRetry }: { onRetry: () => void | Promise<void> }) { return <View style={s.errorCard}><Text style={s.errorTitle}>This section is unavailable.</Text><Pressable onPress={() => void onRetry()} style={s.retry}><Text style={s.retryText}>Retry</Text></Pressable></View>; }
function Empty({ title, detail }: { title: string; detail: string }) { return <View style={s.empty}><Text style={s.emptyTitle}>{title}</Text><Text style={s.support}>{detail}</Text></View>; }

function AttentionRow({ customer, onPress }: { customer: BarberRetentionCustomer; onPress: () => void }) {
  const status = customer.actionable_status as 'AT_RISK' | 'OVERDUE' | 'DUE_SOON';
  const days = Math.abs(customer.days_relative_to_expected ?? 0);
  const timing = status === 'DUE_SOON' ? customer.days_relative_to_expected === 0 ? 'Due today' : `Due in ${days} day${days === 1 ? '' : 's'}` : `${days} day${days === 1 ? '' : 's'} overdue`;
  return <Pressable onPress={onPress} style={({ pressed }) => [s.attentionCard, pressed && s.pressed]}><View style={s.flex}><Text style={s.customerName} numberOfLines={1}>{customer.customer_name}</Text><Text style={s.service} numberOfLines={1}>{customer.last_services || 'Service details unavailable'}</Text><Text style={s.timing}>{timing}</Text></View><StatusBadge status={status} /><MaterialCommunityIcons name="chevron-right" size={20} color={theme.colors.muted} /></Pressable>;
}
function AppointmentRow({ item, timezone }: { item: CalendarAppointment; timezone: string }) {
  return <View style={s.appointmentRow}><View style={s.timeBox}><Text style={s.time}>{new Date(item.start_at).toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hour12: false })}</Text></View><View style={s.flex}><Text style={s.customerName} numberOfLines={1}>{item.customer_name}</Text><Text style={s.service} numberOfLines={1}>{item.services.map(service => service.service_name).join(' + ') || 'Service details unavailable'}</Text></View><Text style={s.appointmentStatus}>{appointmentLabels[item.status]}</Text></View>;
}

const s = StyleSheet.create({
  page: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: theme.spacing.lg, gap: 12 }, flex: { flex: 1, minWidth: 0 }, pressed: { opacity: .65 },
  header: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 2 }, avatar: { width: 42, height: 42, borderRadius: 21 }, avatarFallback: { width: 42, height: 42, borderRadius: 21, backgroundColor: '#EAD9C8', alignItems: 'center', justifyContent: 'center' }, avatarInitials: { color: theme.colors.cognacPressed, fontFamily: theme.fonts.bold, fontSize: 13 }, business: { color: theme.colors.primary, fontSize: 19, lineHeight: 23, fontFamily: theme.fonts.bold }, date: { color: theme.colors.secondary, fontSize: 12, lineHeight: 17, fontFamily: theme.fonts.regular }, iconButton: { width: 42, height: 42, borderRadius: 13, backgroundColor: theme.colors.cardMuted, alignItems: 'center', justifyContent: 'center' },
  metricGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 }, metricCard: { width: '48%', flexGrow: 1, minHeight: 136, backgroundColor: theme.colors.card, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radii.card, padding: 13, ...theme.shadow }, metricIcon: { width: 32, height: 32, borderRadius: 10, backgroundColor: '#F4EADF', alignItems: 'center', justifyContent: 'center', marginBottom: 6 }, metricValue: { color: theme.colors.primary, fontSize: 27, lineHeight: 31, fontFamily: theme.fonts.bold, letterSpacing: -.7 }, metricValueSmall: { fontSize: 22 }, metricLoader: { height: 31, alignSelf: 'flex-start' }, metricLabel: { color: theme.colors.primary, fontSize: 12, lineHeight: 15, fontFamily: theme.fonts.bold }, metricNote: { color: theme.colors.secondary, fontSize: 10, lineHeight: 14, fontFamily: theme.fonts.regular, marginTop: 2 },
  card: { backgroundColor: theme.colors.card, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radii.card, padding: 14, ...theme.shadow }, sectionTop: { minHeight: 44, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }, sectionTitle: { color: theme.colors.primary, fontSize: 18, lineHeight: 23, fontFamily: theme.fonts.bold, letterSpacing: -.25 }, support: { color: theme.colors.secondary, fontSize: 11, lineHeight: 16, fontFamily: theme.fonts.regular }, textAction: { minHeight: 44, flexDirection: 'row', alignItems: 'center' }, actionText: { color: theme.colors.cognacPressed, fontSize: 12, fontFamily: theme.fonts.semibold },
  retentionRows: { marginTop: 8, gap: 2 }, retentionRow: { minHeight: 38, flexDirection: 'row', alignItems: 'center', borderTopWidth: 1, borderTopColor: theme.colors.border, gap: 9 }, dot: { width: 8, height: 8, borderRadius: 4 }, retentionLabel: { flex: 1, color: theme.colors.primary, fontSize: 13, fontFamily: theme.fonts.medium }, retentionValue: { color: theme.colors.primary, fontSize: 18, fontFamily: theme.fonts.bold },
  loader: { minHeight: 90, alignItems: 'center', justifyContent: 'center' }, errorCard: { minHeight: 64, backgroundColor: theme.colors.card, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radii.card, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', gap: 10 }, errorTitle: { flex: 1, color: theme.colors.secondary, fontSize: 13, fontFamily: theme.fonts.medium }, retry: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 }, retryText: { color: theme.colors.cognacPressed, fontSize: 13, fontFamily: theme.fonts.bold },
  empty: { backgroundColor: theme.colors.card, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radii.card, padding: 14 }, emptyTitle: { color: theme.colors.primary, fontSize: 14, lineHeight: 19, fontFamily: theme.fonts.bold },
  attentionCard: { minHeight: 75, backgroundColor: theme.colors.card, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radii.card, padding: 13, flexDirection: 'row', alignItems: 'center', gap: 8, ...theme.shadow }, customerName: { color: theme.colors.primary, fontSize: 14, lineHeight: 19, fontFamily: theme.fonts.bold }, service: { color: theme.colors.secondary, fontSize: 12, lineHeight: 17, fontFamily: theme.fonts.regular }, timing: { color: theme.colors.cognacPressed, fontSize: 11, lineHeight: 15, fontFamily: theme.fonts.semibold, marginTop: 2 },
  appointmentCard: { backgroundColor: theme.colors.card, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radii.card, overflow: 'hidden', ...theme.shadow }, appointmentRow: { minHeight: 65, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 10, borderBottomWidth: 1, borderBottomColor: theme.colors.border }, timeBox: { width: 50, height: 40, borderRadius: 9, backgroundColor: '#F4F2FC', alignItems: 'center', justifyContent: 'center' }, time: { color: theme.colors.primary, fontSize: 12, fontFamily: theme.fonts.bold }, appointmentStatus: { color: theme.colors.secondary, fontSize: 10, fontFamily: theme.fonts.semibold },
});
