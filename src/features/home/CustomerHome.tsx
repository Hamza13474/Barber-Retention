import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { appAlert } from '../../components/AppModal';
import { supabase } from '../../lib/supabase';
import { theme } from '../../theme';
import type { CustomerAppointment, CustomerBusiness, CustomerLoyaltyAccount, CustomerReferralOverview, Profile, Service } from '../../types/database';

type Props = {
  profile: Profile;
  business: CustomerBusiness;
  onBook: () => void;
  onBookAgain: (appointment: CustomerAppointment) => void;
  onChooseDifferent: (appointment: CustomerAppointment) => void;
  onAppointments: () => void;
  onRewards: () => void;
};

type HomeData = {
  upcoming: CustomerAppointment[];
  history: CustomerAppointment[];
  loyalty: CustomerLoyaltyAccount[];
  referrals: CustomerReferralOverview[];
};

const emptyData: HomeData = { upcoming: [], history: [], loyalty: [], referrals: [] };
const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

export function CustomerHome({ profile, business, onBook, onBookAgain, onChooseDifferent, onAppointments, onRewards }: Props) {
  const [data, setData] = useState<HomeData>(emptyData);
  const [currentServices, setCurrentServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [appointmentsError, setAppointmentsError] = useState(false);
  const [loyaltyError, setLoyaltyError] = useState(false);
  const [referralError, setReferralError] = useState(false);

  const load = useCallback(async (refresh = false) => {
    refresh ? setRefreshing(true) : setLoading(true);
    const args = { p_limit: 20, p_before_start_at: null, p_before_id: null };
    const [upcomingResult, historyResult, loyaltyResult, referralResult] = await Promise.all([
      supabase!.rpc('get_customer_appointments', { ...args, p_list: 'upcoming' }),
      loadHistoryUntilCompleted(),
      supabase!.rpc('get_customer_loyalty_accounts'),
      supabase!.rpc('get_customer_referral_overview'),
    ]);
    const appointmentFailed = Boolean(upcomingResult.error || historyResult.error);
    setAppointmentsError(appointmentFailed);
    setLoyaltyError(Boolean(loyaltyResult.error));
    setReferralError(Boolean(referralResult.error));
    const next: HomeData = {
      upcoming: appointmentFailed ? [] : ((upcomingResult.data ?? []) as CustomerAppointment[]).filter(item => item.barber_id === business.id),
      history: appointmentFailed ? [] : ((historyResult.data ?? []) as CustomerAppointment[]).filter(item => item.barber_id === business.id),
      loyalty: loyaltyResult.error ? [] : ((loyaltyResult.data ?? []) as CustomerLoyaltyAccount[]).filter(item => item.barber_id === business.id),
      referrals: referralResult.error ? [] : ((referralResult.data ?? []) as CustomerReferralOverview[]).filter(item => item.barber_id === business.id),
    };
    setData(next);
    const lastCompleted = next.history.find(appointment => appointment.status === 'completed');
    if (lastCompleted?.services.length) {
      const ids = lastCompleted.services.map(service => service.service_id);
      const { data: services } = await supabase!.from('services').select('*').eq('barber_id', lastCompleted.barber_id).eq('is_active', true).in('id', ids);
      setCurrentServices((services ?? []) as Service[]);
    } else setCurrentServices([]);
    setLoading(false);
    setRefreshing(false);
  }, [business]);

  useEffect(() => { void load(); }, [load]);

  const upcoming = useMemo(() => data.upcoming
    .filter(item => item.status === 'booked' && new Date(item.end_at).getTime() > Date.now())
    .sort((a, b) => new Date(a.start_at).getTime() - new Date(b.start_at).getTime())[0], [data.upcoming]);
  const lastCompleted = data.history.find(item => item.status === 'completed');
  const loyalty = data.loyalty.find(item => item.barber_id === business.id);
  const referral = data.referrals.find(item => item.barber_id === business.id);
  const returnDays = currentServices.map(service => service.recommended_return_days).filter((days): days is number => days != null).sort((a, b) => a - b)[0];

  if (loading) return <View style={s.loading}><ActivityIndicator size="large" color={theme.colors.cognac} /><Text style={s.supporting}>Loading your home…</Text></View>;

  return <ScrollView
    contentContainerStyle={s.page}
    refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={theme.colors.cognac} colors={[theme.colors.cognac]} />}
  >
    <BusinessHeader name={business.display_name} avatarUrl={business.avatar_url} />
    <View style={s.greetingBlock}>
      <Text numberOfLines={2} style={s.greeting}>{greeting()}, {firstName(profile.full_name)}</Text>
    </View>

    {appointmentsError ? <ErrorCard title="Appointments unavailable" body="We couldn't load your visits right now." onRetry={() => void load()} />
      : upcoming ? <UpcomingCard appointment={upcoming} onOpen={onAppointments} />
      : <NoUpcoming onBook={onBook} />}

    {!appointmentsError && !upcoming && lastCompleted ? <BookAgainCard appointment={lastCompleted} returnDays={returnDays} onBookAgain={() => onBookAgain(lastCompleted)} onChooseDifferent={() => onChooseDifferent(lastCompleted)} /> : null}
    {!appointmentsError && !upcoming && !lastCompleted ? <FirstVisitCard onBook={onBook} /> : null}

    <BookBanner onPress={onBook} />
    <RewardsPreview account={loyalty} error={loyaltyError} onOpen={onRewards} />
    <ReferralPreview item={referral} error={referralError} />
  </ScrollView>;
}

function BusinessHeader({ name, avatarUrl }: { name?: string; avatarUrl?: string | null }) {
  return <View style={s.businessHeader}><View style={s.businessAvatar}>{avatarUrl ? <Image source={{ uri: avatarUrl }} style={s.businessAvatarImage} /> : <MaterialCommunityIcons name="storefront-outline" size={20} color={theme.colors.secondary} />}</View><Text numberOfLines={1} style={s.businessName}>{name ?? 'Your barber'}</Text></View>;
}

function UpcomingCard({ appointment, onOpen }: { appointment: CustomerAppointment; onOpen: () => void }) {
  const timezone = appointment.barber_timezone || 'Europe/London';
  const date = new Date(appointment.start_at).toLocaleString('en-GB', { timeZone: timezone, weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  return <View style={[s.card, s.upcomingCard]}><View style={s.accent} /><View style={s.cardHeader}><Text style={s.overlineCognac}>UPCOMING VISIT</Text><View style={s.bookedBadge}><MaterialCommunityIcons name="calendar-check-outline" size={14} color="#763F00" /><Text style={s.bookedText}>Booked</Text></View></View><View style={s.divider} />
    <View style={s.whenRow}><MaterialCommunityIcons name="clock-outline" size={19} color={theme.colors.cognacPressed} /><Text style={s.when}>{date}</Text></View>
    <View style={s.mutedPanel}><View style={s.between}><Text style={s.serviceTitle}>{serviceNames(appointment)}</Text><Text style={s.servicePrice}>{money.format(Number(appointment.estimated_total))}</Text></View><Text style={s.supporting}>with {appointment.barber_name} • {appointment.total_duration_minutes} mins</Text><View style={s.inPersonRow}><MaterialCommunityIcons name="cash" size={14} color="#76777B" /><Text style={s.inPerson}>Pay in person</Text></View></View>
    <Pressable style={({ pressed }) => [s.outlineButton, pressed && s.pressed]} onPress={onOpen}><MaterialCommunityIcons name="calendar-blank-outline" size={19} color={theme.colors.primary} /><Text style={s.outlineButtonText}>View appointment</Text></Pressable>
  </View>;
}

function NoUpcoming({ onBook }: { onBook: () => void }) {
  return <View style={[s.card, s.noUpcoming]}><View style={s.iconMuted}><MaterialCommunityIcons name="calendar-remove-outline" size={23} color="#76777B" /></View><View style={s.flex}><Text style={s.cardTitle}>No upcoming appointment</Text><Text style={s.supporting}>Ready for your next cut?</Text></View><Pressable style={s.smallButton} onPress={onBook}><Text style={s.smallButtonText}>Book visit</Text></Pressable></View>;
}

function BookAgainCard({ appointment, returnDays, onBookAgain, onChooseDifferent }: { appointment: CustomerAppointment; returnDays?: number; onBookAgain: () => void; onChooseDifferent: () => void }) {
  return <View style={s.card}><View style={s.cardHeader}><View style={s.labelRow}><MaterialCommunityIcons name="repeat" size={18} color={theme.colors.cognacPressed} /><Text style={s.overline}>BOOK AGAIN</Text></View>{returnDays ? <Text style={s.returnBadge}>{returnContext(appointment.end_at, returnDays)}</Text> : null}</View>
    <View style={s.mutedPanel}><View style={s.cardHeader}><Text style={s.metaLabel}>YOUR LAST VISIT</Text><Text numberOfLines={1} style={s.barberLabel}>{appointment.barber_name}</Text></View><View style={s.between}><Text numberOfLines={2} style={s.serviceTitle}>{serviceNames(appointment)}</Text><Text style={s.servicePrice}>{money.format(Number(appointment.estimated_total))} · {appointment.total_duration_minutes} min</Text></View>{returnDays ? <Text style={s.supporting}>Recommended return: {returnDays} days</Text> : null}</View>
    <Pressable style={({ pressed }) => [s.primaryButton, pressed && s.primaryPressed]} onPress={onBookAgain}><MaterialCommunityIcons name="lightning-bolt" size={19} color="#FFFFFF" /><Text style={s.primaryButtonText}>Book Again</Text></Pressable>
    <Pressable style={s.textButton} onPress={onChooseDifferent}><Text style={s.textButtonLabel}>Choose a different service</Text></Pressable>
  </View>;
}

function FirstVisitCard({ onBook }: { onBook: () => void }) {
  return <View style={s.card}><View style={s.labelRow}><MaterialCommunityIcons name="content-cut" size={18} color={theme.colors.cognacPressed} /><Text style={s.overline}>YOUR FIRST VISIT</Text></View><Text style={s.cardTitle}>Ready for a fresh cut?</Text><Text style={s.supporting}>Choose a service, date and time. Your visits and rewards will appear here afterwards.</Text><Pressable style={s.primaryButton} onPress={onBook}><Text style={s.primaryButtonText}>Book your first appointment</Text></Pressable></View>;
}

function BookBanner({ onPress }: { onPress: () => void }) {
  return <Pressable style={({ pressed }) => [s.bookBanner, pressed && s.bannerPressed]} onPress={onPress}><View style={s.bannerIcon}><MaterialCommunityIcons name="calendar-plus" size={24} color="#FFB77C" /></View><View style={s.flex}><Text style={s.bannerTitle}>Book an appointment</Text><Text style={s.bannerBody}>Choose a service and time for your next visit</Text></View><MaterialCommunityIcons name="arrow-right" size={24} color="#FFFFFF" /></Pressable>;
}

function RewardsPreview({ account, error, onOpen }: { account?: CustomerLoyaltyAccount; error: boolean; onOpen: () => void }) {
  const rewards = [...(account?.rewards ?? [])].filter(reward => reward.is_active).sort((a, b) => a.points_required - b.points_required);
  const next = rewards.find(reward => reward.points_required > (account?.balance ?? 0));
  const reachable = rewards.filter(reward => reward.points_required <= (account?.balance ?? 0)).at(-1);
  const target = next ?? reachable;
  const balance = account?.balance ?? 0;
  const progress = target ? Math.min(100, balance / target.points_required * 100) : 0;
  return <View style={s.card}><View style={s.cardHeader}><View style={s.labelRow}><MaterialCommunityIcons name="medal-outline" size={18} color={theme.colors.cognacPressed} /><Text style={s.overline}>YOUR REWARDS</Text></View><Pressable onPress={onOpen}><Text style={s.link}>View rewards →</Text></Pressable></View>
    {error ? <Text style={s.supporting}>Rewards are unavailable right now.</Text> : account ? <><View style={s.pointsRow}><Text style={s.points}>{balance}</Text><Text style={s.pointsUnit}>points</Text></View>{target ? <><View style={s.progress}><View style={[s.progressFill, { width: `${progress}%` }]} /></View><View style={s.between}><Text style={s.progressLabel}>{balance} / {target.points_required} points</Text><Text style={s.progressLabel}>{next ? `${next.points_required - balance} pts to next reward` : 'Reward unlocked'}</Text></View><View style={s.rewardNote}><MaterialCommunityIcons name="piggy-bank-outline" size={18} color={theme.colors.cognacPressed} /><View style={s.flex}><Text style={s.rewardTitle}>{next ? `${next.points_required - balance} points until ${next.title}` : `${target.title} is ready`}</Text><Text style={s.rewardCaption}>Earn 1 point per £1 on completed visits</Text></View></View></> : <><Text style={s.supporting}>No active reward is configured yet.</Text><Text style={s.rewardCaption}>Earn 1 point per £1 on completed visits</Text></>}</> : <><Text style={s.points}>0 <Text style={s.pointsUnit}>points</Text></Text><Text style={s.supporting}>Complete your first visit to start earning rewards.</Text><Text style={s.rewardCaption}>Earn 1 point per £1 on completed visits</Text></>}
  </View>;
}

function ReferralPreview({ item, error }: { item?: CustomerReferralOverview; error: boolean }) {
  const copy = async () => {
    if (!item?.referral_code) return;
    await Clipboard.setStringAsync(item.referral_code);
    appAlert('Code copied', 'Your referral code is ready to share.');
  };
  return <View style={[s.card, s.referralCard]}><View style={s.referralIntro}><View style={s.referralIcon}><MaterialCommunityIcons name="account-multiple-plus-outline" size={24} color="#763F00" /></View><View style={s.flex}><Text style={s.cardTitle}>Invite a friend</Text><Text style={s.supporting}>{item ? `Invite a friend to ${item.barber_name}. Earn ${item.reward_points} points after their first completed visit.` : error ? 'Referral details are unavailable right now.' : 'Complete your first visit to unlock a barber-specific referral code.'}</Text></View></View>{item?.referral_code ? <View style={s.codeRow}><View style={s.codeBox}><Text numberOfLines={1} style={s.code}>{item.referral_code}</Text><MaterialCommunityIcons name="content-copy" size={17} color="#76777B" /></View><Pressable style={s.copyButton} onPress={() => void copy()}><MaterialCommunityIcons name="content-copy" size={17} color="#FFFFFF" /><Text style={s.copyText}>Copy code</Text></Pressable></View> : null}</View>;
}

function ErrorCard({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }) {
  return <View style={s.card}><Text style={s.cardTitle}>{title}</Text><Text style={s.supporting}>{body}</Text><Pressable style={s.outlineButton} onPress={onRetry}><Text style={s.outlineButtonText}>Try again</Text></Pressable></View>;
}

function firstName(name: string) { return name.trim().split(/\s+/)[0] || 'there'; }
function greeting() { const hour = new Date().getHours(); return hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'; }
function serviceNames(appointment: CustomerAppointment) { return appointment.services.length ? appointment.services.map(service => service.service_name).join(' + ') : 'Service details unavailable'; }
async function loadHistoryUntilCompleted() {
  const history: CustomerAppointment[] = [];
  let cursor: CustomerAppointment | undefined;
  while (true) {
    const { data, error } = await supabase!.rpc('get_customer_appointments', {
      p_list: 'history', p_limit: 25, p_before_start_at: cursor?.start_at ?? null, p_before_id: cursor?.id ?? null,
    });
    if (error) return { data: [] as CustomerAppointment[], error: true };
    const page = (data ?? []) as CustomerAppointment[];
    history.push(...page);
    if (page.some(item => item.status === 'completed') || page.length < 25) return { data: history, error: false };
    cursor = page.at(-1);
  }
}
function returnContext(endAt: string, days: number) {
  const due = new Date(endAt).getTime() + days * 86400000;
  const difference = Math.ceil((due - Date.now()) / 86400000);
  if (difference === 0) return 'Due back today';
  return difference > 0 ? `Due back in ${difference} day${difference === 1 ? '' : 's'}` : `Due ${Math.abs(difference)} day${difference === -1 ? '' : 's'} ago`;
}

const s = StyleSheet.create({
  page: { flexGrow: 1, padding: 16, paddingTop: 0, paddingBottom: 28, gap: 20, backgroundColor: '#FBF8FF' },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, backgroundColor: '#FBF8FF' },
  businessHeader: { minHeight: 50, marginHorizontal: -16, paddingHorizontal: 20, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: '#FFFFFF', borderBottomWidth: 1, borderBottomColor: '#C6C6CB' },
  businessAvatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: '#E8E7F1', borderWidth: 1, borderColor: '#C6C6CB', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }, businessAvatarImage: { width: 32, height: 32 },
  businessName: { flex: 1, color: theme.colors.primary, fontFamily: theme.fonts.bold, fontSize: 16, lineHeight: 21 },
  greetingBlock: { gap: 3 }, greeting: { color: '#000000', fontFamily: theme.fonts.bold, fontSize: 25, lineHeight: 31, letterSpacing: -0.55 }, contextRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6 }, context: { flex: 1, color: '#45474B', fontFamily: theme.fonts.regular, fontSize: 13, lineHeight: 19 }, contextStrong: { color: '#000000', fontFamily: theme.fonts.semibold },
  card: { backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#C6C6CB', borderRadius: 16, padding: 16, gap: 12, ...theme.shadow }, upcomingCard: { overflow: 'hidden' }, accent: { position: 'absolute', left: 0, right: 0, top: 0, height: 4, backgroundColor: '#8D4F0E' }, cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }, divider: { height: 1, backgroundColor: '#EEEDF7' }, overline: { color: '#45474B', fontFamily: theme.fonts.bold, fontSize: 11, letterSpacing: 1 }, overlineCognac: { color: '#8D4F0E', fontFamily: theme.fonts.bold, fontSize: 11, letterSpacing: 1 }, labelRow: { flexDirection: 'row', alignItems: 'center', gap: 6 }, bookedBadge: { flexDirection: 'row', alignItems: 'center', gap: 4, borderRadius: 999, paddingVertical: 3, paddingHorizontal: 8, backgroundColor: '#FFDCC2' }, bookedText: { color: '#2E1500', fontFamily: theme.fonts.semibold, fontSize: 12 },
  whenRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 9 }, when: { flex: 1, color: '#000000', fontFamily: theme.fonts.bold, fontSize: 16, lineHeight: 22 }, mutedPanel: { backgroundColor: '#F4F2FD', borderWidth: 1, borderColor: '#C6C6CB', borderRadius: 12, padding: 12, gap: 5 }, between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }, serviceTitle: { flex: 1, minWidth: 0, color: '#000000', fontFamily: theme.fonts.semibold, fontSize: 15, lineHeight: 21 }, servicePrice: { flexShrink: 0, color: '#000000', fontFamily: theme.fonts.bold, fontSize: 13, lineHeight: 20, textAlign: 'right' }, supporting: { color: '#626269', fontFamily: theme.fonts.regular, fontSize: 13, lineHeight: 18 }, inPersonRow: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingTop: 1 }, inPerson: { color: '#76777B', fontFamily: theme.fonts.semibold, fontSize: 12, lineHeight: 17 },
  outlineButton: { minHeight: 44, borderRadius: 12, borderWidth: 1, borderColor: '#C6C6CB', backgroundColor: '#F4F2FD', flexDirection: 'row', gap: 8, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 14 }, outlineButtonText: { color: '#181A1E', fontFamily: theme.fonts.semibold, fontSize: 13 }, pressed: { backgroundColor: '#E8E7F1' },
  noUpcoming: { flexDirection: 'row', alignItems: 'center', gap: 10 }, iconMuted: { width: 42, height: 42, borderRadius: 12, backgroundColor: '#EEEDF7', alignItems: 'center', justifyContent: 'center' }, flex: { flex: 1, minWidth: 0 }, cardTitle: { color: '#000000', fontFamily: theme.fonts.bold, fontSize: 17, lineHeight: 22 }, smallButton: { minHeight: 40, flexShrink: 0, justifyContent: 'center', paddingHorizontal: 12, borderRadius: 10, backgroundColor: '#EEEDF7', borderWidth: 1, borderColor: '#C6C6CB' }, smallButtonText: { color: '#000000', fontFamily: theme.fonts.medium, fontSize: 13 },
  returnBadge: { color: '#763F00', backgroundColor: '#FFDCC2', borderRadius: 999, paddingVertical: 4, paddingHorizontal: 10, fontFamily: theme.fonts.medium, fontSize: 11 }, metaLabel: { color: '#76777B', fontFamily: theme.fonts.bold, fontSize: 11, letterSpacing: 0.8 }, barberLabel: { maxWidth: '52%', color: '#8D4F0E', fontFamily: theme.fonts.semibold, fontSize: 11, textAlign: 'right' }, primaryButton: { minHeight: 48, paddingHorizontal: 16, borderRadius: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: '#000000' }, primaryPressed: { backgroundColor: '#1A1C20' }, primaryButtonText: { color: '#FFFFFF', fontFamily: theme.fonts.bold, fontSize: 14 }, textButton: { minHeight: 36, alignItems: 'center', justifyContent: 'center' }, textButtonLabel: { color: '#45474B', fontFamily: theme.fonts.semibold, fontSize: 14 },
  bookBanner: { minHeight: 96, backgroundColor: '#1A1C20', borderWidth: 1, borderColor: '#45474B', borderRadius: 16, paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 11, ...theme.shadow }, bannerPressed: { backgroundColor: '#2F3038' }, bannerIcon: { width: 42, height: 42, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: '#37383F' }, bannerTitle: { color: '#FFFFFF', fontFamily: theme.fonts.bold, fontSize: 17, lineHeight: 22 }, bannerBody: { color: '#A1A1AA', fontFamily: theme.fonts.regular, fontSize: 13, lineHeight: 18 },
  link: { color: '#8D4F0E', fontFamily: theme.fonts.semibold, fontSize: 13 }, pointsRow: { flexDirection: 'row', alignItems: 'baseline', gap: 7 }, points: { color: '#000000', fontFamily: theme.fonts.bold, fontSize: 32, lineHeight: 39 }, pointsUnit: { color: '#45474B', fontFamily: theme.fonts.regular, fontSize: 18 }, progress: { height: 9, backgroundColor: '#EEEDF7', borderWidth: 1, borderColor: '#C6C6CB', borderRadius: 999, overflow: 'hidden' }, progressFill: { height: '100%', backgroundColor: '#8D4F0E', borderRadius: 999 }, progressLabel: { flexShrink: 1, color: '#45474B', fontFamily: theme.fonts.semibold, fontSize: 10, lineHeight: 15 }, rewardNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, backgroundColor: '#F4F2FD', borderWidth: 1, borderColor: '#C6C6CB', borderRadius: 12, padding: 11 }, rewardTitle: { color: '#181A1E', fontFamily: theme.fonts.semibold, fontSize: 13, lineHeight: 18 }, rewardCaption: { color: '#76777B', fontFamily: theme.fonts.semibold, fontSize: 11, lineHeight: 17 },
  referralCard: { backgroundColor: '#F8F6FF' }, referralIntro: { flexDirection: 'row', alignItems: 'flex-start', gap: 11 }, referralIcon: { width: 42, height: 42, borderRadius: 12, backgroundColor: '#FFDCC2', alignItems: 'center', justifyContent: 'center' }, codeRow: { flexDirection: 'row', gap: 8 }, codeBox: { minWidth: 0, flex: 1, minHeight: 44, paddingHorizontal: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 6, backgroundColor: '#FFFFFF', borderWidth: 1, borderColor: '#C6C6CB', borderRadius: 12 }, code: { flex: 1, minWidth: 0, color: '#000000', fontFamily: theme.fonts.bold, fontSize: 11, letterSpacing: 1 }, copyButton: { minHeight: 44, flexShrink: 0, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 13, borderRadius: 12, backgroundColor: '#9A5200' }, copyText: { color: '#FFFFFF', fontFamily: theme.fonts.bold, fontSize: 12 },
  reminder: { minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, backgroundColor: '#EEEDF7', borderWidth: 1, borderColor: '#C6C6CB', borderRadius: 12, paddingHorizontal: 10, paddingVertical: 8 }, reminderText: { flex: 1, color: '#45474B', fontFamily: theme.fonts.regular, fontSize: 11, lineHeight: 17, textAlign: 'center' },
});
