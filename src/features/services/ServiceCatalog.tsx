import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { appAlert } from '../../components/AppModal';
import { supabase } from '../../lib/supabase';
import type { Profile, Service } from '../../types/database';
import { theme } from '../../theme';

type Form = { name: string; description: string; price: string; duration: string; returnDays: string };
const emptyForm: Form = { name: '', description: '', price: '', duration: '', returnDays: '' };
const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

export function ServiceCatalog({ profile, onBack, backLabel = 'Profile' }: { profile: Profile; onBack: () => void; backLabel?: string }) {
  const barber = profile.role === 'barber';
  const [services, setServices] = useState<Service[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Service | 'new' | null>(null);
  const [form, setForm] = useState<Form>(emptyForm);
  const [saving, setSaving] = useState(false);

  const loadServices = useCallback(async () => {
    if (!supabase) return;
    setLoading(true); setError(null);
    let query = supabase.from('services').select('*').order('name');
    query = barber ? query.eq('barber_id', profile.id) : query.eq('is_active', true);
    const { data, error: loadError } = await query;
    if (loadError) setError('Services could not be loaded. Check that the Phase 2 migration has been applied.');
    else setServices((data ?? []) as Service[]);
    setLoading(false);
  }, [barber, profile.id]);
  useEffect(() => { void loadServices(); }, [loadServices]);

  const startEdit = (service: Service | 'new') => {
    setEditing(service);
    setForm(service === 'new' ? emptyForm : { name: service.name, description: service.description ?? '', price: Number(service.price).toFixed(2), duration: String(service.duration_minutes), returnDays: service.recommended_return_days ? String(service.recommended_return_days) : '' });
  };
  const set = (key: keyof Form, value: string) => setForm(current => ({ ...current, [key]: value }));

  const save = async () => {
    if (!supabase || !editing) return;
    const name = form.name.trim(), price = Number(form.price), duration = Number(form.duration);
    const returnDays = form.returnDays.trim() ? Number(form.returnDays) : null;
    if (!name) return appAlert('Name required', 'Enter a service name.');
    if (!Number.isFinite(price) || price < 0) return appAlert('Invalid price', 'Enter a price of zero or more.');
    if (!Number.isInteger(duration) || duration <= 0) return appAlert('Invalid duration', 'Duration must be a whole number greater than zero.');
    if (returnDays !== null && (!Number.isInteger(returnDays) || returnDays <= 0)) return appAlert('Invalid return period', 'Recommended return days must be a whole number greater than zero.');
    const values = { name, description: form.description.trim() || null, price, duration_minutes: duration, recommended_return_days: returnDays };
    setSaving(true);
    const result = editing === 'new' ? await supabase.from('services').insert({ ...values, barber_id: profile.id }) : await supabase.from('services').update(values).eq('id', editing.id);
    setSaving(false);
    if (result.error) return appAlert('Could not save service', 'Check the service details and try again.');
    const wasNew = editing === 'new'; setEditing(null); await loadServices();
    appAlert('Service saved', wasNew ? 'The service was added.' : 'Your changes were saved.');
  };

  const toggleActive = (service: Service) => appAlert(service.is_active ? 'Deactivate service?' : 'Reactivate service?', service.is_active ? 'Customers will no longer see this service.' : 'Customers will be able to see this service again.', [
    { text: 'Cancel', style: 'cancel' },
    { text: service.is_active ? 'Deactivate' : 'Reactivate', style: service.is_active ? 'destructive' : 'default', onPress: async () => {
      if (!supabase) return;
      const { error: updateError } = await supabase.from('services').update({ is_active: !service.is_active }).eq('id', service.id);
      if (updateError) appAlert('Could not update service', 'Refresh and try again.'); else await loadServices();
    } },
  ]);

  return <View style={styles.section}>
    <View style={styles.header}><Pressable onPress={onBack}><Text style={styles.link}>‹ {backLabel}</Text></Pressable>{barber && !editing && <Pressable onPress={() => startEdit('new')}><Text style={styles.link}>+ Add service</Text></Pressable>}</View>
    <View><Text style={styles.eyebrow}>{barber ? 'YOUR CATALOG' : 'SERVICE CATALOG'}</Text><Text style={styles.title}>Services</Text><Text style={styles.body}>{barber ? 'Manage what you offer and when customers can see it.' : 'Browse active services offered by barbers.'}</Text></View>
    {editing && barber ? <View style={styles.card}><Text style={styles.cardTitle}>{editing === 'new' ? 'Add service' : 'Edit service'}</Text>
      <Field label="Service name" value={form.name} onChangeText={value => set('name', value)} />
      <Field label="Description (optional)" value={form.description} onChangeText={value => set('description', value)} multiline />
      <View style={styles.row}><View style={styles.flex}><Field label="Price (£)" value={form.price} onChangeText={value => set('price', value)} keyboardType="decimal-pad" /></View><View style={styles.flex}><Field label="Duration (minutes)" value={form.duration} onChangeText={value => set('duration', value)} keyboardType="number-pad" /></View></View>
      <Field label="Recommended return (days, optional)" value={form.returnDays} onChangeText={value => set('returnDays', value)} keyboardType="number-pad" /><Text style={styles.helper}>Used later for retention and reminder logic.</Text>
      <Pressable style={[styles.button, saving && styles.disabled]} onPress={save} disabled={saving}><Text style={styles.buttonText}>{saving ? 'Saving…' : 'Save service'}</Text></Pressable><Pressable onPress={() => setEditing(null)} disabled={saving}><Text style={styles.centerLink}>Cancel</Text></Pressable>
    </View> : null}
    {loading ? <ActivityIndicator size="large" color="#D9A441" /> : error ? <View style={styles.card}><Text style={styles.error}>{error}</Text><Pressable onPress={loadServices}><Text style={styles.centerLink}>Try again</Text></Pressable></View> : services.length === 0 ? <View style={styles.card}><Text style={styles.cardTitle}>{barber ? 'No services yet' : 'No active services yet'}</Text><Text style={styles.body}>{barber ? 'Add your first service to start building your catalog.' : 'Active barber services will appear here.'}</Text>{barber && <Pressable style={styles.button} onPress={() => startEdit('new')}><Text style={styles.buttonText}>Add first service</Text></Pressable>}</View> : services.map(service => <View style={[styles.card, !service.is_active && styles.inactive]} key={service.id}>
      <View style={styles.serviceTop}><View style={styles.flex}><Text style={styles.cardTitle}>{service.name}</Text><Text style={styles.meta}>{money.format(Number(service.price))} · {service.duration_minutes} minutes</Text></View>{barber && <Text style={[styles.badge, service.is_active ? styles.activeBadge : styles.inactiveBadge]}>{service.is_active ? 'ACTIVE' : 'INACTIVE'}</Text>}</View>
      {service.description ? <Text style={styles.body}>{service.description}</Text> : null}{service.recommended_return_days ? <Text style={styles.returnText}>Recommended return: {service.recommended_return_days} days</Text> : null}
      {barber && <View style={styles.actions}><Pressable onPress={() => startEdit(service)}><Text style={styles.link}>Edit</Text></Pressable><Pressable onPress={() => toggleActive(service)}><Text style={styles.link}>{service.is_active ? 'Deactivate' : 'Reactivate'}</Text></Pressable></View>}
    </View>)}
  </View>;
}

function Field({ label, ...props }: { label: string } & React.ComponentProps<typeof TextInput>) { return <View><Text style={styles.label}>{label}</Text><TextInput style={[styles.input, props.multiline && styles.multiline]} placeholderTextColor="#817F79" {...props} /></View>; }
const styles = StyleSheet.create({ section:{gap:16},header:{minHeight:48,flexDirection:'row',justifyContent:'space-between',alignItems:'center'},eyebrow:{color:theme.colors.cognacPressed,fontFamily:theme.fonts.bold,fontSize:10,letterSpacing:1},title:{color:theme.colors.primary,fontFamily:theme.fonts.bold,fontSize:theme.type.display,lineHeight:35},body:{color:theme.colors.secondary,fontFamily:theme.fonts.regular,fontSize:13,lineHeight:20},card:{backgroundColor:theme.colors.card,borderWidth:1,borderColor:theme.colors.border,borderRadius:theme.radii.card,padding:16,gap:12,...theme.shadow},inactive:{opacity:.7},cardTitle:{color:theme.colors.primary,fontFamily:theme.fonts.bold,fontSize:18,lineHeight:23},label:{color:theme.colors.primary,fontFamily:theme.fonts.semibold,fontSize:13,marginBottom:7},input:{minHeight:48,color:theme.colors.primary,backgroundColor:theme.colors.cardMuted,borderWidth:1,borderColor:'#D1D5DB',borderRadius:theme.radii.input,paddingHorizontal:13,fontFamily:theme.fonts.regular,fontSize:15},multiline:{minHeight:82,textAlignVertical:'top',paddingTop:12},row:{flexDirection:'row',gap:10,flexWrap:'wrap'},flex:{flex:1,minWidth:130},helper:{color:theme.colors.secondary,fontFamily:theme.fonts.regular,fontSize:12,marginTop:-5},button:{minHeight:48,alignItems:'center',justifyContent:'center',backgroundColor:theme.colors.primary,borderRadius:theme.radii.input,paddingHorizontal:15},disabled:{opacity:.55},buttonText:{color:'#FFFFFF',fontFamily:theme.fonts.bold,fontSize:14},link:{minHeight:44,color:theme.colors.cognacPressed,fontFamily:theme.fonts.bold,paddingVertical:12},centerLink:{minHeight:44,color:theme.colors.cognacPressed,textAlign:'center',textAlignVertical:'center',fontFamily:theme.fonts.bold},error:{color:'#B42318',lineHeight:21},serviceTop:{flexDirection:'row',alignItems:'flex-start',gap:10},meta:{color:theme.colors.primary,fontFamily:theme.fonts.semibold,fontSize:14,marginTop:4},returnText:{color:theme.colors.cognacPressed,fontFamily:theme.fonts.medium,fontSize:12},badge:{borderRadius:theme.radii.pill,overflow:'hidden',paddingHorizontal:9,paddingVertical:5,fontFamily:theme.fonts.bold,fontSize:10},activeBadge:{backgroundColor:theme.colors.active.background,color:theme.colors.active.text},inactiveBadge:{backgroundColor:'#F1F2F4',color:theme.colors.secondary},actions:{borderTopColor:theme.colors.border,borderTopWidth:1,paddingTop:2,flexDirection:'row',justifyContent:'space-between'} });
