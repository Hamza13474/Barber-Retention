import { useCallback, useEffect, useMemo, useState } from 'react';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { appAlert } from '../../components/AppModal';
import { supabase } from '../../lib/supabase';
import type { AppointmentStatus, BlockedPeriod, CalendarAppointment, CalendarView, Profile } from '../../types/database';
import { theme } from '../../theme';
import { DateTimeField } from '../../components/DateTimeField';

const money = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
const statusText: Record<AppointmentStatus, string> = { booked: 'Booked', completed: 'Completed', no_show: 'No-show', cancelled_by_customer: 'Cancelled by customer', cancelled_by_barber: 'Cancelled by barber' };
const appointmentPill: Record<AppointmentStatus, { backgroundColor: string; borderColor: string }> = { booked: { backgroundColor: '#EFF4F8', borderColor: '#D7E0E8' }, completed: { backgroundColor: theme.colors.active.background, borderColor: theme.colors.active.border }, no_show: { backgroundColor: theme.colors.atRisk.background, borderColor: theme.colors.atRisk.border }, cancelled_by_customer: { backgroundColor: theme.colors.cardMuted, borderColor: theme.colors.border }, cancelled_by_barber: { backgroundColor: theme.colors.atRisk.background, borderColor: theme.colors.atRisk.border } };
const appointmentText: Record<AppointmentStatus, string> = { booked: '#334155', completed: theme.colors.active.text, no_show: theme.colors.atRisk.text, cancelled_by_customer: theme.colors.secondary, cancelled_by_barber: theme.colors.atRisk.text };
const pad = (n: number) => String(n).padStart(2, '0');
const isoDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (value: string) => { const [y, m, d] = value.split('-').map(Number); return new Date(y, m - 1, d, 12); };
const shiftDate = (value: string, days: number) => { const d = parseDate(value); d.setDate(d.getDate() + days); return isoDate(d); };
const monthShift = (value: string, amount: number) => { const d = parseDate(value); d.setDate(1); d.setMonth(d.getMonth() + amount); return isoDate(d); };
const parts = (instant: Date, timezone: string) => Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(instant).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
// Convert a local wall-clock boundary in an IANA zone to its UTC instant. Two
// passes handle normal offset changes; calendar boundaries avoid ambiguous hours.
const zonedBoundary = (date: string, timezone: string) => { const [year, month, day] = date.split('-').map(Number); const desired = Date.UTC(year, month - 1, day); let value = desired; for (let i = 0; i < 3; i++) { const p = parts(new Date(value), timezone); value += desired - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second); } return new Date(value).toISOString(); };
type WallTimeResult = { iso: string | null; error?: 'invalid' | 'nonexistent' };
// Resolve a complete local wall-clock value without assuming a 24-hour local day.
// Candidate UTC offsets are sampled around the date and every candidate must round
// trip to the exact requested fields. A DST gap therefore has no candidate. During
// a fall-back overlap, choosing the latest UTC candidate selects the standard-time
// occurrence, matching PostgreSQL AT TIME ZONE and Phase 3's canonical policy.
const zonedWallTime = (value: string, timezone: string): WallTimeResult => {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) return { iso: null, error: 'invalid' };
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return { iso: null, error: 'invalid' };
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const normalized = new Date(wall);
  if (normalized.getUTCFullYear() !== year || normalized.getUTCMonth() !== month - 1 || normalized.getUTCDate() !== day) return { iso: null, error: 'invalid' };
  const offsets = new Set<number>();
  for (const hours of [-36, -12, 0, 12, 36]) {
    const instant = new Date(wall + hours * 3600000); const p = parts(instant, timezone);
    offsets.add(Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant.getTime());
  }
  const candidates = [...offsets].map(offset => wall - offset).filter(candidate => {
    const p = parts(new Date(candidate), timezone);
    return p.year === year && p.month === month && p.day === day && p.hour === hour && p.minute === minute && p.second === 0;
  });
  if (!candidates.length) return { iso: null, error: 'nonexistent' };
  return { iso: new Date(Math.max(...candidates)).toISOString() };
};
const localDate = (value: string, timezone: string) => { const p = parts(new Date(value), timezone); return `${p.year}-${pad(p.month)}-${pad(p.day)}`; };
const time = (value: string, timezone: string) => new Date(value).toLocaleTimeString('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });

export function BarberCalendar({ profile, onBack, showBack = true }: { profile: Profile; onBack: () => void; showBack?: boolean }) {
  const timezone = profile.timezone || 'Europe/London';
  const today = localDate(new Date().toISOString(), timezone);
  const [view, setView] = useState<CalendarView>('day'); const [selected, setSelected] = useState(today);
  const [appointments, setAppointments] = useState<CalendarAppointment[]>([]); const [blocks, setBlocks] = useState<BlockedPeriod[]>([]); const [loading, setLoading] = useState(true); const [opened, setOpened] = useState<CalendarAppointment | null>(null); const [blockEditor, setBlockEditor] = useState<BlockedPeriod | 'new' | null>(null);
  const range = useMemo(() => {
    if (view === 'day') return { from: selected, to: shiftDate(selected, 1) };
    const d = parseDate(selected);
    if (view === 'week') { const mondayOffset = (d.getDay() + 6) % 7; const from = shiftDate(selected, -mondayOffset); return { from, to: shiftDate(from, 7) }; }
    const from = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`; return { from, to: monthShift(from, 1) };
  }, [selected, view]);
  const load = useCallback(async () => {
    if (!supabase) return; setLoading(true); const from = zonedBoundary(range.from, timezone), to = zonedBoundary(range.to, timezone);
    const [a, b] = await Promise.all([supabase.rpc('get_barber_calendar', { p_from: from, p_to: to }), supabase.from('blocked_periods').select('*').lt('start_at', to).gt('end_at', from).order('start_at')]);
    if (a.error || b.error) appAlert('Calendar unavailable', 'Please try loading the calendar again.');
    else { setAppointments((a.data ?? []) as CalendarAppointment[]); setBlocks((b.data ?? []) as BlockedPeriod[]); }
    setLoading(false);
  }, [range.from, range.to, timezone]);
  useEffect(() => { void load(); }, [load]);
  const go = (direction: number) => setSelected(view === 'day' ? shiftDate(selected, direction) : view === 'week' ? shiftDate(selected, direction * 7) : monthShift(selected, direction));
  const dayItems = useCallback((date: string) => ({ appointments: appointments.filter(x => localDate(x.start_at, timezone) === date), blocks: blocks.filter(x => localDate(x.start_at, timezone) <= date && localDate(new Date(new Date(x.end_at).getTime() - 1).toISOString(), timezone) >= date) }), [appointments, blocks, timezone]);
  const chooseDay = (date: string) => { setSelected(date); setView('day'); };
  const business = profile.display_name || profile.full_name;
  return <View style={s.section}>
    {showBack && <Pressable onPress={onBack} style={s.back}><MaterialCommunityIcons name="arrow-left" size={22} color={theme.colors.primary}/><Text style={s.backText}>More</Text></Pressable>}
    <View><Text style={s.eyebrow} numberOfLines={1}>{business}</Text><Text style={s.title}>Calendar</Text><Text style={s.muted}>Times shown in {timezone}</Text></View>
    <View style={s.tabs}><Pressable onPress={() => setView('day')} style={[s.tab, view === 'day' && s.tabOn]}><Text style={[s.tabText, view === 'day' && s.tabTextOn]}>Day</Text></Pressable><Pressable onPress={() => setView('month')} style={[s.tab, view === 'month' && s.tabOn]}><Text style={[s.tabText, view === 'month' && s.tabTextOn]}>Month</Text></Pressable></View>
    <DateTimeField label="Selected date" mode="date" value={parseDate(selected)} onChange={value => chooseDay(isoDate(value))} />
    <View style={s.nav}><Pressable onPress={() => go(-1)} style={s.navTap}><MaterialCommunityIcons name="chevron-left" size={27} color={theme.colors.primary}/></Pressable><View style={s.navCenter}><Text style={s.selectedLabel}>{view === 'month' ? parseDate(selected).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : selected === today ? 'Today' : parseDate(selected).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</Text>{selected !== today ? <Pressable accessibilityRole="button" onPress={() => setSelected(today)}><Text style={s.todayAction}>Go to today</Text></Pressable> : null}</View><Pressable onPress={() => go(1)} style={s.navTap}><MaterialCommunityIcons name="chevron-right" size={27} color={theme.colors.primary}/></Pressable></View>
    {loading ? <View style={s.loading}><ActivityIndicator color={theme.colors.cognac}/><Text style={s.muted}>Loading schedule…</Text></View> : view === 'day' ? <Day date={selected} timezone={timezone} data={dayItems(selected)} onAppointment={setOpened} onBlock={x => setBlockEditor(x)} /> : view === 'week' ? <Week from={range.from} timezone={timezone} items={dayItems} onDay={chooseDay} /> : <Month selected={selected} timezone={timezone} items={dayItems} onDay={chooseDay} />}
    <Button label="Block time" onPress={() => setBlockEditor('new')} />
    <AppointmentModal item={opened} timezone={timezone} close={() => setOpened(null)} changed={() => { setOpened(null); void load(); }} />
    <BlockModal value={blockEditor} timezone={timezone} close={() => setBlockEditor(null)} changed={() => { setBlockEditor(null); void load(); }} />
  </View>;
}

function Day({ date, timezone, data, onAppointment, onBlock }: { date: string; timezone: string; data: { appointments: CalendarAppointment[]; blocks: BlockedPeriod[] }; onAppointment: (x: CalendarAppointment) => void; onBlock: (x: BlockedPeriod) => void }) {
  const entries = [...data.appointments.map(item => ({ start: item.start_at, kind: 'appointment' as const, item })), ...data.blocks.map(item => ({ start: item.start_at, kind: 'block' as const, item }))].sort((a,b) => a.start.localeCompare(b.start));
  return <View style={s.section}><View style={s.dayHeading}><Text style={s.heading}>{parseDate(date).toLocaleDateString('en-GB', { weekday:'long', day:'numeric', month:'long' })}</Text><Text style={s.dayCount}>{data.appointments.length} appointment{data.appointments.length===1?'':'s'}</Text></View>{entries.length === 0 ? <View style={s.empty}><MaterialCommunityIcons name="calendar-blank-outline" size={28} color={theme.colors.muted}/><Text style={s.muted}>Nothing scheduled for this day.</Text></View> : entries.map(entry => entry.kind === 'appointment' ? <AppointmentCard key={entry.item.id} item={entry.item} timezone={timezone} onPress={() => onAppointment(entry.item)} /> : <Pressable key={entry.item.id} onPress={() => onBlock(entry.item)} style={[s.card,s.block]}><Text style={s.blockLabel}>BLOCKED TIME</Text><Text style={s.cardTitle}>{time(entry.item.start_at,timezone)}–{time(entry.item.end_at,timezone)}</Text><Text style={s.muted}>{entry.item.reason || 'Unavailable'}</Text></Pressable>)}</View>;
}
function AppointmentCard({ item, timezone, onPress }: { item: CalendarAppointment; timezone: string; onPress: () => void }) { return <Pressable onPress={onPress} style={({pressed})=>[s.card,s[item.status],pressed&&s.pressed]}><View style={s.between}><View style={s.timeRow}><MaterialCommunityIcons name="clock-outline" size={18} color={theme.colors.cognacPressed}/><Text style={s.cardTitle}>{time(item.start_at,timezone)}–{time(item.end_at,timezone)}</Text><Text style={s.duration}>· {item.total_duration_minutes} min</Text></View><View style={[s.statusPill,appointmentPill[item.status]]}><Text style={[s.badge,{color:appointmentText[item.status]}]}>{statusText[item.status]}</Text></View></View><Text style={s.name}>{item.customer_name}</Text><Text style={s.muted}>{item.services.map(x => x.service_name).join(' + ') || 'Service details unavailable'}</Text><View style={s.tapHint}><Text style={s.tapText}>View appointment</Text><MaterialCommunityIcons name="chevron-right" size={18} color={theme.colors.muted}/></View></Pressable>; }
function Week({ from, timezone, items, onDay }: { from: string; timezone: string; items: (d:string) => {appointments:CalendarAppointment[];blocks:BlockedPeriod[]}; onDay:(d:string)=>void }) { return <View style={s.section}><Text style={s.heading}>Week of {parseDate(from).toLocaleDateString('en-GB',{day:'numeric',month:'long'})}</Text>{Array.from({length:7},(_,i)=>shiftDate(from,i)).map(date=>{const x=items(date);return <Pressable key={date} style={s.dayRow} onPress={()=>onDay(date)}><View><Text style={s.name}>{parseDate(date).toLocaleDateString('en-GB',{weekday:'short',day:'numeric'})}</Text><Text style={s.muted}>{x.appointments.length} appointment{x.appointments.length===1?'':'s'}{x.blocks.length ? ` · ${x.blocks.length} blocked` : ''}</Text></View><Text style={s.times}>{x.appointments.map(a=>time(a.start_at,timezone)).join(', ') || '—'}</Text></Pressable>})}</View>; }
function Month({ selected, items, onDay }: { selected:string; timezone:string; items:(d:string)=>{appointments:CalendarAppointment[];blocks:BlockedPeriod[]}; onDay:(d:string)=>void }) { const d=parseDate(selected), first=new Date(d.getFullYear(),d.getMonth(),1,12), days=new Date(d.getFullYear(),d.getMonth()+1,0).getDate(), lead=(first.getDay()+6)%7; return <View style={s.section}><Text style={s.heading}>{first.toLocaleDateString('en-GB',{month:'long',year:'numeric'})}</Text><View style={s.weekLabels}>{['M','T','W','T','F','S','S'].map((x,i)=><Text key={i} style={s.weekLabel}>{x}</Text>)}</View><View style={s.grid}>{Array.from({length:lead},(_,i)=><View key={`b${i}`} style={s.cell}/>) }{Array.from({length:days},(_,i)=>{const date=`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(i+1)}`,x=items(date);return <Pressable key={date} style={[s.cell,date===selected&&s.cellOn]} onPress={()=>onDay(date)}><Text style={[s.cellText,date===selected&&s.cellTextOn]}>{i+1}</Text><Text style={s.dots}>{x.appointments.length?'●':''}{x.blocks.length?' ■':''}</Text></Pressable>})}</View><Text style={s.muted}>● appointment   ■ blocked time</Text></View>; }

function AppointmentModal({ item, timezone, close, changed }: { item:CalendarAppointment|null; timezone:string; close:()=>void; changed:()=>void }) {
  const [busy,setBusy]=useState(false);
  if(!item)return null;
  const update=(status:'completed'|'no_show'|'cancelled_by_barber')=>appAlert(
    `${status==='no_show'?'Mark no-show':status==='completed'?'Complete appointment':'Cancel appointment'}?`,
    'This status is final and cannot be reversed.',
    [{text:'Keep booked',style:'cancel'},{text:'Confirm',style:status==='cancelled_by_barber'?'destructive':'default',onPress:async()=>{
      if(busy)return;
      setBusy(true);
      const {error}=await supabase!.rpc('update_barber_appointment_status',{p_appointment_id:item.id,p_status:status});
      setBusy(false);
      if(error)appAlert('Status not changed',friendlyStatusError(error.message));else changed();
    }}]
  );
  return <Modal visible transparent animationType="slide" onRequestClose={close}><View style={s.overlay}><ScrollView contentContainerStyle={s.sheet}><View style={s.between}><Text style={s.heading}>Appointment</Text><Pressable onPress={close}><Text style={s.link}>Close</Text></Pressable></View><Text style={s.name}>{item.customer_name}</Text><Text style={s.badge}>{statusText[item.status]}</Text><Detail label="Starts" value={`${new Date(item.start_at).toLocaleDateString('en-GB',{timeZone:timezone,dateStyle:'medium'})}, ${time(item.start_at,timezone)}`} /><Detail label="Ends" value={time(item.end_at,timezone)} /><Detail label="Total" value={`${item.total_duration_minutes} min · ${money.format(Number(item.estimated_total))}`} /><Text style={s.heading}>Booked services</Text>{item.services.map(x=><View key={x.id} style={s.service}><Text style={s.name}>{x.service_name}</Text><Text style={s.muted}>{x.duration_minutes} min · {money.format(Number(x.price))}</Text></View>)}{item.status==='booked'&&<><Button label={busy?'Updating…':'Mark completed'} disabled={busy} onPress={()=>update('completed')} /><Button label="Mark no-show" disabled={busy} onPress={()=>update('no_show')} /><Pressable disabled={busy} onPress={()=>update('cancelled_by_barber')}><Text style={s.danger}>Cancel appointment</Text></Pressable></>}</ScrollView></View></Modal>;
}
const friendlyStatusError=(message:string)=>message.includes('start time')?'The appointment start time must arrive before it can be completed or marked no-show.':message.includes('future')?'Only future booked appointments can be cancelled.':message.includes('Only booked')?'This appointment has already reached a final status.':'The appointment could not be updated. Refresh and try again.';
function Detail({label,value}:{label:string;value:string}){return <View><Text style={s.label}>{label}</Text><Text style={s.name}>{value}</Text></View>}
function BlockModal({value,timezone,close,changed}:{value:BlockedPeriod|'new'|null;timezone:string;close:()=>void;changed:()=>void}) {
  const existing=value&&value!=='new'?value:null;
  const format=(v:string)=>{const p=parts(new Date(v),timezone);return `${p.year}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`};
  const fromWall=(v:string)=>{const [date,time]=v.split(' '),[year,month,day]=date.split('-').map(Number),[hour,minute]=time.split(':').map(Number);return new Date(year,month-1,day,hour,minute)};
  const initial=new Date(); initial.setMinutes(0,0,0); initial.setHours(initial.getHours()+1);
  const [date,setDate]=useState(initial),[start,setStart]=useState(initial),[end,setEnd]=useState(new Date(initial.getTime()+3600000)),[reason,setReason]=useState(''),[busy,setBusy]=useState(false);
  useEffect(()=>{const a=existing?fromWall(format(existing.start_at)):initial,b=existing?fromWall(format(existing.end_at)):new Date(initial.getTime()+3600000);setDate(a);setStart(a);setEnd(b);setReason(existing?.reason||'')},[value]);
  if(!value)return null;
  const save=async()=>{
    const wall=(timeValue:Date)=>`${isoDate(date)} ${pad(timeValue.getHours())}:${pad(timeValue.getMinutes())}`;
    const startResult=zonedWallTime(wall(start),timezone),endResult=zonedWallTime(wall(end),timezone);
    if(startResult.error==='nonexistent'||endResult.error==='nonexistent') return appAlert('Time unavailable','That local time does not exist because of a daylight-saving time change. Choose another time.');
    const a=startResult.iso,b=endResult.iso;
    if(!a||!b) return appAlert('Check the times','Choose a valid date and time.');
    if(a>=b) return appAlert('Check the times','Make the end later than the start.');
    setBusy(true);
    const values={barber_id:existing?.barber_id,start_at:a,end_at:b,reason:reason.trim()||null};
    const result=existing?await supabase!.from('blocked_periods').update({start_at:a,end_at:b,reason:values.reason}).eq('id',existing.id):await supabase!.from('blocked_periods').insert({...values,barber_id:undefined});
    setBusy(false);
    if(result.error)appAlert('Blocked time not saved',result.error.message.includes('booked appointment')?'That time overlaps a booked appointment. Cancel the appointment first or choose another time.':'Check the times and try again.');else changed();
  };
  const remove=()=>existing&&appAlert('Remove blocked time?','Customers may be able to book this time again.',[{text:'Keep',style:'cancel'},{text:'Remove',style:'destructive',onPress:async()=>{const {error}=await supabase!.from('blocked_periods').delete().eq('id',existing.id);if(error)appAlert('Could not remove blocked time','Only a future blocked period can be removed.');else changed();}}]);
  return <Modal visible transparent animationType="slide" onRequestClose={close}><View style={s.overlay}><View style={s.sheet}><View style={s.between}><Text style={s.heading}>{existing?'Edit':'Add'} blocked time</Text><Pressable onPress={close}><Text style={s.link}>Close</Text></Pressable></View><Text style={s.muted}>Times use {timezone}</Text><DateTimeField label="Date" mode="date" value={date} minimumDate={new Date()} onChange={setDate}/><View style={s.timeRowFields}><DateTimeField label="Start time" mode="time" value={start} onChange={setStart}/><DateTimeField label="End time" mode="time" value={end} onChange={setEnd}/></View><Field label="Reason (optional)" value={reason} onChangeText={setReason}/><Button label={busy?'Saving…':'Save Block Time'} disabled={busy} onPress={save}/>{existing&&<Pressable onPress={remove}><Text style={s.danger}>Remove blocked time</Text></Pressable>}</View></View></Modal>;
}
function Field({label,...props}:{label:string}&React.ComponentProps<typeof TextInput>){return <View><Text style={s.label}>{label}</Text><TextInput style={s.input} placeholderTextColor="#817F79" {...props}/></View>}
function Button({label,onPress,disabled}:{label:string;onPress:()=>void;disabled?:boolean}){return <Pressable onPress={onPress} disabled={disabled} style={[s.button,disabled&&{opacity:.5}]}><Text style={s.buttonText}>{label}</Text></Pressable>}

const s=StyleSheet.create({section:{gap:14},pressed:{opacity:.68},back:{minHeight:44,alignSelf:'flex-start',flexDirection:'row',alignItems:'center',gap:6},backText:{color:theme.colors.primary,fontFamily:theme.fonts.semibold,fontSize:theme.type.body},eyebrow:{color:theme.colors.cognacPressed,fontSize:11,fontFamily:theme.fonts.bold,letterSpacing:1.1,textTransform:'uppercase'},title:{color:theme.colors.primary,fontSize:theme.type.display,lineHeight:34,fontFamily:theme.fonts.bold},heading:{color:theme.colors.primary,fontSize:18,lineHeight:24,fontFamily:theme.fonts.bold,flexShrink:1},link:{color:theme.colors.cognacPressed,fontFamily:theme.fonts.bold},muted:{color:theme.colors.secondary,lineHeight:20,fontFamily:theme.fonts.regular,fontSize:theme.type.small},tabs:{flexDirection:'row',backgroundColor:'#E8E7ED',borderRadius:theme.radii.input,padding:4},tab:{flex:1,alignItems:'center',padding:10,borderRadius:9,minHeight:42},tabOn:{backgroundColor:theme.colors.primary},tabText:{color:theme.colors.secondary,fontFamily:theme.fonts.semibold},tabTextOn:{color:theme.colors.card},nav:{flexDirection:'row',justifyContent:'space-between',alignItems:'center'},navTap:{width:44,height:44,alignItems:'center',justifyContent:'center'},navCenter:{flex:1,alignItems:'center',justifyContent:'center'},selectedLabel:{color:theme.colors.primary,fontFamily:theme.fonts.bold,fontSize:15},todayAction:{color:theme.colors.cognacPressed,fontFamily:theme.fonts.semibold,fontSize:11,paddingTop:3},loading:{padding:28,alignItems:'center',gap:10},dayHeading:{flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:10},dayCount:{color:theme.colors.secondary,backgroundColor:'#ECEAF2',borderRadius:theme.radii.pill,paddingHorizontal:10,paddingVertical:5,fontFamily:theme.fonts.medium,fontSize:11},card:{backgroundColor:theme.colors.card,borderRadius:theme.radii.card,padding:16,gap:8,borderWidth:1,borderColor:'#D7D8DC',...theme.shadow},booked:{borderLeftWidth:4,borderLeftColor:theme.colors.cognac},completed:{borderLeftWidth:4,borderLeftColor:theme.colors.active.text},no_show:{borderLeftWidth:4,borderLeftColor:theme.colors.atRisk.text},cancelled_by_customer:{borderLeftWidth:4,borderLeftColor:theme.colors.muted},cancelled_by_barber:{borderLeftWidth:4,borderLeftColor:theme.colors.atRisk.text},block:{borderLeftWidth:4,borderLeftColor:'#7C6AA6',backgroundColor:theme.colors.cardMuted},blockLabel:{color:'#6C5795',fontSize:11,fontFamily:theme.fonts.bold,letterSpacing:1},between:{flexDirection:'row',justifyContent:'space-between',alignItems:'flex-start',gap:8,flexWrap:'wrap'},timeRow:{flexDirection:'row',alignItems:'center',gap:5,flexShrink:1,flexWrap:'wrap'},timeRowFields:{flexDirection:'row',gap:10},cardTitle:{color:theme.colors.primary,fontSize:15,fontFamily:theme.fonts.bold},duration:{color:theme.colors.secondary,fontFamily:theme.fonts.regular,fontSize:12},name:{color:theme.colors.primary,fontSize:17,lineHeight:23,fontFamily:theme.fonts.bold},statusPill:{borderWidth:1,borderRadius:theme.radii.pill,paddingHorizontal:9,paddingVertical:4},badge:{fontSize:11,fontFamily:theme.fonts.bold},tapHint:{borderTopWidth:1,borderTopColor:theme.colors.border,paddingTop:8,marginTop:2,flexDirection:'row',alignItems:'center',justifyContent:'flex-end'},tapText:{color:theme.colors.secondary,fontFamily:theme.fonts.semibold,fontSize:12},empty:{backgroundColor:theme.colors.card,padding:24,borderRadius:theme.radii.card,borderWidth:1,borderColor:theme.colors.border,alignItems:'center',gap:8},dayRow:{backgroundColor:theme.colors.card,padding:14,borderRadius:theme.radii.input,borderWidth:1,borderColor:theme.colors.border,flexDirection:'row',justifyContent:'space-between',alignItems:'center'},times:{color:theme.colors.cognacPressed,maxWidth:'45%',textAlign:'right',fontFamily:theme.fonts.semibold},weekLabels:{flexDirection:'row'},weekLabel:{width:'14.285%',textAlign:'center',color:theme.colors.secondary,fontFamily:theme.fonts.bold},grid:{flexDirection:'row',flexWrap:'wrap'},cell:{width:'14.285%',height:58,alignItems:'center',justifyContent:'center',borderRadius:9},cellOn:{backgroundColor:theme.colors.primary},cellText:{color:theme.colors.primary,fontFamily:theme.fonts.bold},cellTextOn:{color:theme.colors.card},dots:{color:theme.colors.cognac,fontSize:9,minHeight:12},button:{minHeight:48,alignItems:'center',justifyContent:'center',backgroundColor:theme.colors.primary,borderRadius:theme.radii.input,padding:14},buttonText:{color:theme.colors.card,fontFamily:theme.fonts.bold},overlay:{flex:1,backgroundColor:'rgba(0,0,0,.55)',justifyContent:'flex-end'},sheet:{backgroundColor:theme.colors.card,padding:22,paddingBottom:36,gap:16,borderTopLeftRadius:24,borderTopRightRadius:24,maxHeight:'90%'},service:{borderTopWidth:1,borderTopColor:theme.colors.border,paddingTop:10},label:{color:theme.colors.secondary,fontSize:13,fontFamily:theme.fonts.semibold,marginBottom:6},input:{color:theme.colors.primary,backgroundColor:theme.colors.cardMuted,borderWidth:1,borderColor:theme.colors.border,borderRadius:10,padding:12},danger:{color:theme.colors.atRisk.text,fontFamily:theme.fonts.bold,textAlign:'center',padding:12}});
