import { StatusBar } from 'expo-status-bar';
import {
  PlusJakartaSans_400Regular,
  PlusJakartaSans_500Medium,
  PlusJakartaSans_600SemiBold,
  PlusJakartaSans_700Bold,
  useFonts,
} from '@expo-google-fonts/plus-jakarta-sans';
import { useEffect, useState } from 'react';
import { ActivityIndicator, BackHandler, Image, Platform, Pressable, SafeAreaView, ScrollView, StatusBar as NativeStatusBar, StyleSheet, Text, TextInput, View } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { isSupabaseConfigured, supabase } from './src/lib/supabase';
import type { BarberCustomerDetail, CustomerAppointment, CustomerBusiness, Profile } from './src/types/database';
import { ServiceCatalog } from './src/features/services/ServiceCatalog';
import { AvailabilityManager } from './src/features/availability/AvailabilityManager';
import { Booking } from './src/features/booking/Booking';
import { CustomerAppointments } from './src/features/appointments/CustomerAppointments';
import { BarberCalendar } from './src/features/calendar/BarberCalendar';
import { NotificationPreferences } from './src/features/notifications/NotificationPreferences';
import { listenForReminderTaps, releaseCurrentDevice } from './src/features/notifications/notifications';
import { CustomerLoyalty } from './src/features/loyalty/CustomerLoyalty';
import { BarberLoyalty } from './src/features/loyalty/BarberLoyalty';
import { CustomerReferrals } from './src/features/referrals/CustomerReferrals';
import { BarberCustomers } from './src/features/customers/BarberCustomers';
import { BarberRetentionDashboard } from './src/features/retention/BarberRetentionDashboard';
import { BarberDashboard } from './src/features/dashboard/BarberDashboard';
import { BarberMore, type BarberMoreDestination } from './src/features/more/BarberMore';
import { BottomTabBar, type BarberTab, type CustomerTab } from './src/components/BottomTabBar';
import { BarberCustomerDetail as BarberCustomerDetailView } from './src/features/customers/BarberCustomerDetail';
import { CustomerHome } from './src/features/home/CustomerHome';
import { theme } from './src/theme';
import { AppModalHost, appAlert, showAppModal } from './src/components/AppModal';

type Form = { fullName: string; email: string; password: string; phone: string };
const blank: Form = { fullName: '', email: '', password: '', phone: '' };

export default function App() { return <><AppContent /><AppModalHost /></>; }

function AppContent() {
  const [fontsLoaded, fontError] = useFonts({
    PlusJakartaSans_400Regular,
    PlusJakartaSans_500Medium,
    PlusJakartaSans_600SemiBold,
    PlusJakartaSans_700Bold,
  });
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    if (!supabase) return setLoading(false);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setProfile(null); return setLoading(false); }
    const { data, error } = await supabase.from('profiles').select('*, barber_profiles(*), customer_profiles(*)').eq('id', user.id).single();
    if (error) appAlert('Profile unavailable', 'Please check your connection and try again.');
    else { const detail = data.role === 'barber' ? data.barber_profiles : data.customer_profiles; setProfile({ ...data, ...(detail ?? {}) }); }
    setLoading(false);
  };
  useEffect(() => {
    if (!supabase) return void setLoading(false);
    load();
    const { data } = supabase.auth.onAuthStateChange((_event, session) => { if (session) load(); else { setProfile(null); setLoading(false); } });
    return () => data.subscription.unsubscribe();
  }, []);
  if (fontError) return <SafeAreaView style={fontGate.safe}><StatusBar style="dark" /><View style={fontGate.center}><Text style={fontGate.title}>Unable to load app fonts.</Text><Text style={fontGate.body}>Please restart the app and try again.</Text></View></SafeAreaView>;
  if (!fontsLoaded) return <SafeAreaView style={fontGate.safe}><StatusBar style="dark" /><View style={fontGate.center}><ActivityIndicator size="large" color={theme.colors.cognac} /></View></SafeAreaView>;
  if (!isSupabaseConfigured) return <Layout><View style={s.hero}><Text style={s.eyebrow}>BARBER RETENTION</Text><Text style={s.title}>One small setup step.</Text><Text style={s.body}>Add your Supabase project URL and publishable key to .env. The exact instructions are in README.md.</Text></View></Layout>;
  if (loading) return <Layout center><ActivityIndicator size="large" color="#D9A441" /></Layout>;
  return profile ? profile.role === 'barber' ? <BarberApp profile={profile} reload={load} /> : <CustomerApp profile={profile} reload={load} /> : <AuthScreen reload={load} />;
}

function AuthScreen({ reload }: { reload: () => Promise<void> }) {
  const [register, setRegister] = useState(false); const [form, setForm] = useState<Form>(blank); const [busy, setBusy] = useState(false);
  useEffect(() => { const subscription = BackHandler.addEventListener('hardwareBackPress', () => { if (!register) return false; setRegister(false); return true; }); return () => subscription.remove(); }, [register]);
  const set = (key: keyof Form, value: string) => setForm(x => ({ ...x, [key]: value }));
  const submit = async () => {
    if (!supabase || !form.email || !form.password || (register && !form.fullName)) return appAlert('Missing information', 'Complete all required fields.');
    setBusy(true);
    if (register) {
      const { data, error } = await supabase.auth.signUp({ email: form.email.trim(), password: form.password, options: { data: { full_name: form.fullName.trim(), phone: form.phone.trim(), role: 'customer' } } });
      setBusy(false);
      if (error) return appAlert('Could not create account', friendlySignupError(error.code, error.message));
      if (data.session) {
        await reload();
        showAppModal({ title: 'Account created', message: 'Your account is ready. Welcome to Barber App.', variant: 'success' });
        return;
      }
      if (data.user?.identities?.length === 0) return appAlert('Account already exists', 'An account already exists with this email. Try signing in instead.');
      if (data.user) return appAlert('Check your email', 'We sent you a confirmation link. Open it to finish creating your account.');
      return appAlert('Could not create account', 'Check your details and try again.');
    }
    const { error } = await supabase.auth.signInWithPassword({ email: form.email.trim(), password: form.password });
    setBusy(false);
    if (error) return appAlert('Unable to sign in', 'Check your email and password, then try again.');
    await reload();
  };
  return <Layout center><View style={s.hero}><Text style={s.eyebrow}>BARBER APP</Text><Text style={s.title}>{register ? 'Create your account' : 'Welcome back'}</Text><Text style={s.body}>{register ? 'Register as a customer to book and manage your visits.' : 'Sign in with your existing customer or barber account.'}</Text></View><View style={s.card}>
    {register && <Field label="Full name" value={form.fullName} onChangeText={x => set('fullName', x)} />}
    <Field label="Email address" value={form.email} onChangeText={x => set('email', x)} keyboardType="email-address" autoCapitalize="none" />
    {register && <Field label="Mobile number" value={form.phone} onChangeText={x => set('phone', x)} keyboardType="phone-pad" />}
    <Field label="Password" value={form.password} onChangeText={x => set('password', x)} secureTextEntry />
    <Button label={busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'} onPress={submit} disabled={busy} />
    <Pressable onPress={() => setRegister(!register)}><Text style={s.link}>{register ? 'Already have an account? Sign in' : 'New here? Create an account'}</Text></Pressable>
  </View></Layout>;
}

function friendlySignupError(code?: string, message = '') {
  if (code === 'user_already_exists' || code === 'email_exists' || /already (registered|exists)|user.*exists/i.test(message)) return 'An account already exists with this email. Try signing in instead.';
  if (code === 'weak_password' || /password/i.test(message)) return 'Choose a stronger password and try again.';
  if (code === 'validation_failed' || /email/i.test(message)) return 'Check your email address and try again.';
  return 'We could not create your account. Check your details and try again.';
}

type BarberNested = BarberMoreDestination | 'retention' | 'customerDetail';
type CustomerDetailSource = 'Dashboard' | 'Customers' | 'Retention';

function BarberApp({ profile, reload }: { profile: Profile; reload: () => Promise<void> }) {
  const [tab, setTab] = useState<BarberTab>('dashboard');
  const [nested, setNested] = useState<BarberNested | null>(null);
  const [detail, setDetail] = useState<BarberCustomerDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailSource, setDetailSource] = useState<CustomerDetailSource>('Dashboard');
  const [signingOut, setSigningOut] = useState(false);
  const openCustomer = async (customerId: string, source: CustomerDetailSource) => {
    setDetailSource(source); setNested('customerDetail'); setDetail(null); setDetailLoading(true);
    const { data, error } = await supabase!.rpc('get_barber_customer_detail', { p_customer_id: customerId });
    setDetailLoading(false);
    if (error) appAlert('Could not load customer details', 'Please try again.');
    else setDetail(((data ?? [])[0] ?? null) as BarberCustomerDetail | null);
  };
  const closeDetail = () => {
    setDetail(null);
    if (detailSource === 'Retention') setNested('retention');
    else { setNested(null); setTab(detailSource === 'Customers' ? 'customers' : 'dashboard'); }
  };
  const signOut = async () => {
    if (signingOut) return; setSigningOut(true);
    const { error } = await supabase!.auth.signOut();
    setSigningOut(false);
    if (error) appAlert('Could not sign out', 'Please try again.');
  };
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (nested === 'customerDetail') { closeDetail(); return true; }
      if (nested) { setNested(null); return true; }
      if (tab !== 'dashboard') { setTab('dashboard'); return true; }
      return false;
    });
    return () => subscription.remove();
  }, [nested, tab, detailSource]);

  if (nested === 'services') return <Layout><ServiceCatalog profile={profile} onBack={() => setNested(null)} backLabel="More" /></Layout>;
  if (nested === 'availability') return <Layout><AvailabilityManager profile={profile} onBack={() => setNested(null)} backLabel="More" /></Layout>;
  if (nested === 'loyalty') return <Layout><BarberLoyalty profile={profile} onBack={() => setNested(null)} backLabel="More" onOpenCustomers={() => { setNested(null); setTab('customers'); }} /></Layout>;
  if (nested === 'businessProfile') return <ProfileScreen profile={profile} reload={reload} businessOnly onBack={() => setNested(null)} />;
  if (nested === 'retention') return <OperationalLayout><BarberRetentionDashboard profile={profile} onBack={() => { setNested(null); setTab('dashboard'); }} onOpenCustomer={id => void openCustomer(id, 'Retention')} /></OperationalLayout>;
  if (nested === 'customerDetail') return <OperationalLayout><BarberCustomerDetailView customer={detail} loading={detailLoading} onBack={closeDetail} backLabel={detailSource} /></OperationalLayout>;

  const changeTab = (next: BarberTab) => { setNested(null); setTab(next); };
  return <SafeAreaView style={barberShell.safe}><StatusBar style="dark" /><View style={barberShell.content}>
    <ScrollView contentContainerStyle={[barberShell.scroll, (tab === 'calendar' || tab === 'customers') && barberShell.operational]} keyboardShouldPersistTaps="handled">
      {tab === 'dashboard' ? <BarberDashboard profile={profile} onOpenRetention={() => setNested('retention')} onOpenCustomer={id => void openCustomer(id, 'Dashboard')} onOpenCalendar={() => changeTab('calendar')} /> : null}
      {tab === 'calendar' ? <BarberCalendar profile={profile} onBack={() => changeTab('dashboard')} showBack={false} /> : null}
      {tab === 'customers' ? <BarberCustomers onBack={() => changeTab('dashboard')} showBack={false} /> : null}
      {tab === 'more' ? <BarberMore profile={profile} busy={signingOut} onOpen={setNested} onSignOut={() => void signOut()} /> : null}
    </ScrollView>
  </View><BottomTabBar active={tab} onChange={changeTab} /></SafeAreaView>;
}

function CustomerApp({ profile, reload }: { profile: Profile; reload: () => Promise<void> }) {
  const [tab, setTab] = useState<CustomerTab>('home');
  const [nested, setNested] = useState<'referrals' | null>(null);
  const [nestedSource, setNestedSource] = useState<CustomerTab>('profile');
  const [bookingSource, setBookingSource] = useState<CustomerTab>('home');
  const [business, setBusiness] = useState<CustomerBusiness | null>(null);
  const [businessLoading, setBusinessLoading] = useState(true);
  const [businessError, setBusinessError] = useState<string | null>(null);
  const [bookingServiceIds, setBookingServiceIds] = useState<string[]>([]);

  const resolveBusiness = async () => {
    setBusinessLoading(true);
    setBusiness(null); setBusinessError(null);
    const { data, error } = await supabase!.rpc('list_bookable_barbers');
    const configured = (data ?? []) as CustomerBusiness[];
    if (error) setBusinessError('Business setup is unavailable.');
    else if (configured.length === 0) setBusinessError('Business setup is unavailable.');
    else if (configured.length > 1) setBusinessError('Business configuration is invalid. Please contact support.');
    else { const [onlyBusiness] = configured; setBusiness(onlyBusiness); }
    setBusinessLoading(false);
  };
  useEffect(() => { void resolveBusiness(); }, []);

  const openGeneralBooking = (source: CustomerTab = tab) => {
    setBookingSource(source); setBookingServiceIds([]); setNested(null); setTab('book');
  };
  const openBooking = (appointment: CustomerAppointment, includeServices: boolean, source: CustomerTab = tab) => {
    if (!business || appointment.barber_id !== business.id) return appAlert('Booking unavailable', 'This visit is not available for the configured business.');
    setBookingSource(source);
    setBookingServiceIds(includeServices ? appointment.services.map(service => service.service_id) : []);
    setNested(null); setTab('book');
  };
  useEffect(() => {
    if (!business) return;
    return listenForReminderTaps((route, barberId, serviceIds) => {
      setNested(null);
      if (route === 'booking') {
        if (barberId === business.id) { setBookingSource('home'); setBookingServiceIds(serviceIds ?? []); setTab('book'); }
        else appAlert('Booking unavailable', 'This reminder does not belong to the configured business.');
      } else setTab('appointments');
    });
  }, [business]);

  const closeReferral = () => { setNested(null); setTab(nestedSource); };
  const openReferrals = (source: CustomerTab) => { setNestedSource(source); setNested('referrals'); };
  useEffect(() => {
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (nested === 'referrals') { closeReferral(); return true; }
      if (tab === 'book') { setTab(bookingSource); return true; }
      if (tab !== 'home') { setTab('home'); return true; }
      return false;
    });
    return () => subscription.remove();
  }, [nested, tab, bookingSource, nestedSource]);

  if (businessLoading) return <CustomerBusinessState busy title="Loading business…" />;
  if (!business || businessError) return <CustomerBusinessState title={businessError ?? 'Business setup is unavailable.'} onRetry={() => void resolveBusiness()} />;

  if (nested === 'referrals') return <SafeAreaView style={customerShell.safe}><StatusBar style="dark" /><ScrollView contentContainerStyle={customerShell.flowScroll} keyboardShouldPersistTaps="handled"><CustomerReferrals profile={profile} business={business} onBack={closeReferral} /></ScrollView></SafeAreaView>;

  const legacy = tab === 'profile';
  return <SafeAreaView style={customerShell.safe}><StatusBar style="dark" /><View style={[customerShell.content, legacy && customerShell.legacyContent]}>
    {tab === 'home' ? <CustomerHome profile={profile} business={business} onBook={() => openGeneralBooking('home')} onBookAgain={appointment => openBooking(appointment, true, 'home')} onChooseDifferent={appointment => openBooking(appointment, false, 'home')} onAppointments={() => setTab('appointments')} onRewards={() => setTab('rewards')} /> :
      <ScrollView contentContainerStyle={legacy ? customerShell.legacyScroll : customerShell.flowScroll} keyboardShouldPersistTaps="handled">
        {tab === 'book' ? <Booking profile={profile} business={business} initialServiceIds={bookingServiceIds} onBack={() => setTab(bookingSource)} /> : null}
        {tab === 'rewards' ? <CustomerLoyalty profile={profile} business={business} onBack={() => setTab('home')} onReferrals={() => openReferrals('rewards')} showBack={false} /> : null}
        {tab === 'appointments' ? <CustomerAppointments profile={profile} business={business} onBack={() => setTab('home')} showBack={false} onBookAgain={appointment => openBooking(appointment, true, 'appointments')} /> : null}
        {tab === 'profile' ? <ProfileScreen profile={profile} reload={reload} customerBusiness={business} shellMode onOpenReferrals={() => openReferrals('profile')} /> : null}
      </ScrollView>}
  </View><BottomTabBar role="customer" active={tab} onChange={next => { setNested(null); if (next === 'book') openGeneralBooking(tab); else setTab(next); }} /></SafeAreaView>;
}

function CustomerBusinessState({ title, busy = false, onRetry }: { title: string; busy?: boolean; onRetry?: () => void }) {
  return <SafeAreaView style={customerShell.safe}><StatusBar style="dark" /><View style={customerShell.state}>{busy ? <ActivityIndicator color={theme.colors.cognac} /> : null}<Text style={customerShell.stateTitle}>{title}</Text>{onRetry ? <Pressable style={customerShell.retry} onPress={onRetry}><Text style={customerShell.retryText}>Try again</Text></Pressable> : null}</View></SafeAreaView>;
}

function ProfileScreen({ profile, reload, customerBusiness, businessOnly = false, onBack, shellMode = false, onOpenReferrals }: { profile: Profile; reload: () => Promise<void>; customerBusiness?: CustomerBusiness; businessOnly?: boolean; onBack?: () => void; shellMode?: boolean; onOpenReferrals?: () => void }) {
  const [edit, setEdit] = useState(false); const [screen, setScreen] = useState<'profile'|'services'|'availability'|'booking'|'appointments'|'calendar'|'loyalty'|'referrals'|'customers'|'retention'>('profile'); const [bookingServiceIds, setBookingServiceIds] = useState<string[]>([]); const [form, setForm] = useState(profile); const [busy, setBusy] = useState(false); const barber = profile.role === 'barber';
  useEffect(() => setForm(profile), [profile]);
  useEffect(() => { const subscription = BackHandler.addEventListener('hardwareBackPress', () => { if (edit) { setEdit(false); setForm(profile); return true; } if (screen !== 'profile') { setScreen('profile'); return true; } return false; }); return () => subscription.remove(); }, [edit, screen, profile]);
  const logout = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Barber accounts cannot own customer registrations. A customer must
      // release this installation before session removal so shared devices can
      // safely transfer the Expo token to the next signed-in customer.
      if (!barber) await releaseCurrentDevice();
      const { error } = await supabase!.auth.signOut();
      if (error) throw error;
    } catch {
      appAlert('Could not log out safely', 'We could not release notifications from this device. Please try again.');
    } finally { setBusy(false); }
  };
  const set = (key: keyof Profile, value: string | boolean) => setForm(x => ({ ...x, [key]: value }));
  const choosePhoto = async () => {
    if (!supabase) return;
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) return appAlert('Photo permission needed', 'Allow photo-library access to add a profile photo.');
    const selected = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], allowsEditing: true, aspect: [1, 1], quality: 0.75 });
    if (selected.canceled) return;
    setBusy(true);
    const asset = selected.assets[0]; const extension = asset.mimeType?.split('/')[1] ?? 'jpg'; const path = `${profile.id}/avatar.${extension}`;
    const bytes = await (await fetch(asset.uri)).arrayBuffer();
    const { error } = await supabase.storage.from('avatars').upload(path, bytes, { contentType: asset.mimeType ?? 'image/jpeg', upsert: true });
    setBusy(false);
    if (error) return appAlert('Could not upload photo', 'Check your connection and try again.');
    const { data } = supabase.storage.from('avatars').getPublicUrl(path);
    set('avatar_url', `${data.publicUrl}?v=${Date.now()}`);
  };
  const save = async () => {
    if (!supabase) return; setBusy(true);
    const common = { full_name: form.full_name, phone: form.phone, avatar_url: form.avatar_url };
    const details = { display_name: form.display_name, bio: form.bio, address: form.address, city: form.city, postcode: form.postcode, business_phone: form.business_phone, working_days: form.working_days, opening_time: form.opening_time || null, closing_time: form.closing_time || null, timezone: form.timezone || 'Europe/London' };
    const a = await supabase.from('profiles').update(common).eq('id', profile.id); const b = barber ? await supabase.from('barber_profiles').update(details).eq('id', profile.id) : { error: null };
    setBusy(false); if (a.error || b.error) return appAlert('Could not save', 'Check the information and try again.'); setEdit(false); await reload();
  };
  if (screen === 'services') return <Layout><ServiceCatalog profile={profile} onBack={() => setScreen('profile')} /></Layout>;
  if (screen === 'availability') return <Layout><AvailabilityManager profile={profile} onBack={() => setScreen('profile')} /></Layout>;
  if (screen === 'booking' && customerBusiness) return <Layout><Booking profile={profile} business={customerBusiness} initialServiceIds={bookingServiceIds} onBack={() => { setBookingServiceIds([]); setScreen('appointments'); }} /></Layout>;
  if (screen === 'appointments' && !barber && customerBusiness) return <Layout><CustomerAppointments profile={profile} business={customerBusiness} onBack={() => setScreen('profile')} onBookAgain={(appointment: CustomerAppointment) => { if (appointment.barber_id !== customerBusiness.id) return; setBookingServiceIds(appointment.services.map(x => x.service_id)); setScreen('booking'); }} /></Layout>;
  if (screen === 'calendar') return <Layout><BarberCalendar profile={profile} onBack={() => setScreen('profile')} /></Layout>;
  if (screen === 'loyalty' && (barber || customerBusiness)) return <Layout>{barber ? <BarberLoyalty profile={profile} onBack={() => setScreen('profile')} /> : <CustomerLoyalty profile={profile} business={customerBusiness!} onBack={() => setScreen('profile')} />}</Layout>;
  if (screen === 'referrals' && !barber && customerBusiness) return <Layout><CustomerReferrals profile={profile} business={customerBusiness} onBack={() => setScreen('profile')} /></Layout>;
  if (screen === 'customers' && barber) return <Layout><BarberCustomers onBack={() => setScreen('profile')} /></Layout>;
  if (screen === 'retention' && barber) return <Layout><BarberRetentionDashboard profile={profile} onBack={() => setScreen('profile')} /></Layout>;
  return <ProfileFrame embedded={shellMode}>{businessOnly && onBack ? <Pressable onPress={onBack}><Text style={s.link}>‹ More</Text></Pressable> : null}<View style={s.top}><View><Text style={s.eyebrow}>{businessOnly ? 'BUSINESS PROFILE' : barber ? 'BARBER WORKSPACE' : 'CUSTOMER PROFILE'}</Text><Text style={s.greeting}>Hi, {profile.full_name.split(' ')[0]}</Text></View><Pressable disabled={busy} onPress={() => void logout()}><Text style={s.logout}>{busy ? 'Please wait…' : 'Log out'}</Text></Pressable></View><View style={s.identity}><Pressable style={s.avatar} onPress={edit ? choosePhoto : undefined}>{form.avatar_url ? <Image source={{ uri: form.avatar_url }} style={s.avatarImage} /> : <Text style={s.avatarText}>{profile.full_name.split(' ').map(x => x[0]).slice(0, 2).join('')}</Text>}</Pressable><View style={s.flex}><Text style={s.name}>{profile.full_name}</Text><Text numberOfLines={2} style={s.muted}>{barber ? 'Independent barber' : 'Customer'} · {profile.email}</Text>{edit && <Pressable onPress={choosePhoto}><Text style={s.photoLink}>{busy ? 'Uploading…' : 'Change profile photo'}</Text></Pressable>}</View></View>
    {!edit ? <><Card title="Your profile"><Detail label="Phone" value={profile.phone || 'Not added'} />{barber ? <><Detail label="Business" value={profile.display_name || 'Not added'} /><Detail label="Location" value={[profile.city, profile.postcode].filter(Boolean).join(', ') || 'Not added'} /></> : customerBusiness ? <Detail label="Business" value={customerBusiness.display_name} /> : null}</Card>{!barber && <NotificationPreferences />}{!businessOnly && (barber ? <><Button label="Manage services" onPress={() => setScreen('services')} /><Button label="Manage availability" onPress={() => setScreen('availability')} /></> : shellMode ? null : <><Button label="Book an appointment" onPress={() => { setBookingServiceIds([]); setScreen('booking'); }} /><Button label="View appointments & history" onPress={() => setScreen('appointments')} /></>)}<Button label="Edit profile" onPress={() => setEdit(true)} /></> : <View style={s.card}><Text style={s.cardTitle}>Edit your profile</Text><Field label="Full name" value={form.full_name} onChangeText={x => set('full_name', x)} /><Field label="Phone number" value={form.phone || ''} onChangeText={x => set('phone', x)} keyboardType="phone-pad" />{barber && <BarberForm form={form} set={set} />}<Button label={busy ? 'Saving…' : 'Save changes'} onPress={save} disabled={busy} /><Pressable onPress={() => { setEdit(false); setForm(profile); }}><Text style={s.link}>Cancel</Text></Pressable></View>}
    {!businessOnly && !edit && (barber || !shellMode) && <Button label={barber ? 'Manage loyalty & rewards' : 'View loyalty & rewards'} onPress={() => setScreen('loyalty')} />}
    {!businessOnly && !edit && !barber && <Button label="Refer a friend" onPress={() => shellMode ? onOpenReferrals?.() : setScreen('referrals')} />}
    {!businessOnly && !edit && barber && <Button label="Open calendar" onPress={() => setScreen('calendar')} />}
    {!businessOnly && !edit && barber && <Button label="Customers" onPress={() => setScreen('customers')} />}
    {!businessOnly && !edit && barber && <Button label="Retention" onPress={() => setScreen('retention')} />}
  </ProfileFrame>;
}

function BarberForm({ form, set }: { form: Profile; set: (key: keyof Profile, value: string) => void }) { const field = (key: keyof Profile, label: string, placeholder?: string) => <Field label={label} value={(form[key] as string) || ''} onChangeText={x => set(key, x)} placeholder={placeholder} key={key} />; return <>{field('display_name', 'Business / display name')}{field('bio', 'About your business')}{field('address', 'Address')}<View style={s.row}><View style={s.flex}>{field('city', 'City')}</View><View style={s.flex}>{field('postcode', 'Postcode')}</View></View>{field('business_phone', 'Business phone')}{field('timezone', 'IANA timezone', 'Europe/London')}</>; }
function Layout({ children, center = false }: { children: React.ReactNode; center?: boolean }) { return <SafeAreaView style={s.safe}><StatusBar style="dark" /><ScrollView contentContainerStyle={[s.page, center && s.center]} keyboardShouldPersistTaps="handled">{children}</ScrollView></SafeAreaView>; }
function OperationalLayout({ children }: { children: React.ReactNode }) { return <SafeAreaView style={barberShell.safe}><StatusBar style="dark" /><ScrollView contentContainerStyle={barberShell.operational} keyboardShouldPersistTaps="handled">{children}</ScrollView></SafeAreaView>; }
function ProfileFrame({ children, embedded }: { children: React.ReactNode; embedded: boolean }) { return embedded ? <View style={customerShell.profile}>{children}</View> : <Layout>{children}</Layout>; }
function Field({ label, ...props }: { label: string } & React.ComponentProps<typeof TextInput>) { return <View><Text style={s.label}>{label}</Text><TextInput style={s.input} placeholderTextColor="#817F79" {...props} /></View>; }
function Choice({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) { return <Pressable onPress={onPress} style={[s.choice, active && s.active]}><Text style={[s.choiceText, active && s.activeText]}>{label}</Text></Pressable>; }
function Button({ label, onPress, disabled }: { label: string; onPress: () => void; disabled?: boolean }) { return <Pressable style={[s.button, disabled && s.disabled]} onPress={onPress} disabled={disabled}><Text style={s.buttonText}>{label}</Text></Pressable>; }
function Card({ title, children }: { title: string; children: React.ReactNode }) { return <View style={s.card}><Text style={s.cardTitle}>{title}</Text>{children}</View>; }
function Detail({ label, value }: { label: string; value: string }) { return <View style={s.detail}><Text style={s.detailLabel}>{label}</Text><Text style={s.detailValue}>{value}</Text></View>; }
const s = StyleSheet.create({ safe:{flex:1,paddingTop:Platform.OS==='android'?NativeStatusBar.currentHeight??24:0,backgroundColor:theme.colors.canvas},page:{flexGrow:1,padding:20,gap:16,backgroundColor:theme.colors.canvas},center:{justifyContent:'center'},hero:{gap:8,marginBottom:4},eyebrow:{color:theme.colors.cognacPressed,fontFamily:theme.fonts.bold,fontSize:10,letterSpacing:1},title:{color:theme.colors.primary,fontFamily:theme.fonts.bold,fontSize:theme.type.display,lineHeight:35},body:{color:theme.colors.secondary,fontFamily:theme.fonts.regular,fontSize:14,lineHeight:21},card:{backgroundColor:theme.colors.card,borderWidth:1,borderColor:theme.colors.border,borderRadius:theme.radii.card,padding:18,gap:14,...theme.shadow},cardTitle:{color:theme.colors.primary,fontFamily:theme.fonts.bold,fontSize:18,lineHeight:23},label:{color:theme.colors.primary,fontFamily:theme.fonts.semibold,fontSize:13,marginBottom:7},input:{minHeight:48,color:theme.colors.primary,backgroundColor:theme.colors.cardMuted,borderWidth:1,borderColor:'#D1D5DB',borderRadius:theme.radii.input,paddingHorizontal:13,fontFamily:theme.fonts.regular,fontSize:15},button:{minHeight:48,alignItems:'center',justifyContent:'center',backgroundColor:theme.colors.primary,borderRadius:theme.radii.input,paddingHorizontal:15},disabled:{opacity:.55},buttonText:{color:'#FFFFFF',fontFamily:theme.fonts.bold,fontSize:14},link:{minHeight:44,color:theme.colors.cognacPressed,textAlign:'center',textAlignVertical:'center',fontFamily:theme.fonts.bold},row:{flexDirection:'row',gap:10,flexWrap:'wrap'},flex:{flex:1,minWidth:0},choice:{flex:1,borderRadius:theme.radii.input,borderWidth:1,borderColor:theme.colors.border,padding:13,alignItems:'center'},active:{backgroundColor:'#F1E4D7',borderColor:theme.colors.cognac},choiceText:{color:theme.colors.secondary,fontFamily:theme.fonts.bold},activeText:{color:theme.colors.primary},top:{minHeight:48,flexDirection:'row',justifyContent:'space-between',alignItems:'center'},greeting:{color:theme.colors.primary,fontFamily:theme.fonts.bold,fontSize:24,lineHeight:30,marginTop:2},logout:{minHeight:44,color:'#B42318',fontFamily:theme.fonts.bold,textAlignVertical:'center'},identity:{backgroundColor:theme.colors.card,borderWidth:1,borderColor:theme.colors.border,borderRadius:theme.radii.card,padding:16,flexDirection:'row',alignItems:'center',gap:14,...theme.shadow},avatar:{width:58,height:58,borderRadius:29,backgroundColor:'#F1E4D7',justifyContent:'center',alignItems:'center',overflow:'hidden'},avatarImage:{width:58,height:58},avatarText:{color:theme.colors.cognacPressed,fontFamily:theme.fonts.bold,fontSize:20},name:{color:theme.colors.primary,fontFamily:theme.fonts.bold,fontSize:19,lineHeight:24},muted:{color:theme.colors.secondary,fontFamily:theme.fonts.regular,fontSize:13,lineHeight:19,marginTop:3},photoLink:{minHeight:40,color:theme.colors.cognacPressed,textAlignVertical:'center',fontFamily:theme.fonts.bold,fontSize:12},detail:{paddingTop:10,borderTopColor:theme.colors.border,borderTopWidth:1,gap:3},detailLabel:{color:theme.colors.secondary,fontFamily:theme.fonts.medium,fontSize:12},detailValue:{color:theme.colors.primary,fontFamily:theme.fonts.semibold,fontSize:15,lineHeight:21},switch:{flexDirection:'row',justifyContent:'space-between',alignItems:'center'},helper:{color:theme.colors.secondary,fontSize:12} });
const barberShell = StyleSheet.create({ safe: { flex: 1, paddingTop: Platform.OS === 'android' ? NativeStatusBar.currentHeight ?? 24 : 0, backgroundColor: theme.colors.card }, content: { flex: 1, backgroundColor: theme.colors.canvas }, scroll: { flexGrow: 1, backgroundColor: theme.colors.canvas }, operational: { flexGrow: 1, paddingHorizontal: 16, paddingTop: 10, paddingBottom: 28, backgroundColor: theme.colors.canvas } });
const customerShell = StyleSheet.create({ safe:{flex:1,paddingTop:Platform.OS==='android'?NativeStatusBar.currentHeight??24:0,backgroundColor:theme.colors.card},content:{flex:1,backgroundColor:theme.colors.canvas},legacyContent:{backgroundColor:theme.colors.canvas},flowScroll:{flexGrow:1,paddingBottom:28,backgroundColor:theme.colors.canvas},legacyScroll:{flexGrow:1,padding:20,gap:16,backgroundColor:theme.colors.canvas},profile:{gap:16},state:{flex:1,padding:24,alignItems:'center',justifyContent:'center',gap:14,backgroundColor:theme.colors.canvas},stateTitle:{color:theme.colors.primary,fontFamily:theme.fonts.bold,fontSize:18,textAlign:'center'},retry:{minHeight:46,paddingHorizontal:20,alignItems:'center',justifyContent:'center',borderRadius:12,backgroundColor:theme.colors.primary},retryText:{color:theme.colors.card,fontFamily:theme.fonts.bold} });
const fontGate = StyleSheet.create({ safe: { flex: 1, backgroundColor: theme.colors.canvas }, center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 8 }, title: { color: theme.colors.primary, fontSize: 18, fontWeight: '700' }, body: { color: theme.colors.secondary, fontSize: 14, textAlign: 'center' } });
