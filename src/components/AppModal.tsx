import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Modal, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

export type AppModalVariant = 'information' | 'success' | 'error' | 'confirmation' | 'destructive';
export type AppModalAction = { text: string; style?: 'default' | 'cancel' | 'destructive'; onPress?: () => void | Promise<void> };
export type AppModalRequest = { title: string; message?: string; variant?: AppModalVariant; actions?: AppModalAction[] };
type Listener = (request: AppModalRequest) => void;
let listener: Listener | null = null;
let pendingRequest: AppModalRequest | null = null;

const inferVariant = (title: string, actions: AppModalAction[]): AppModalVariant => {
  if (actions.some(action => action.style === 'destructive')) return 'destructive';
  if (actions.length > 1) return 'confirmation';
  if (/saved|redeemed|copied|connected|confirmed|success/i.test(title)) return 'success';
  if (/could not|unable|unavailable|failed|invalid|missing|not |check |error/i.test(title)) return 'error';
  return 'information';
};

export function showAppModal(request: AppModalRequest) {
  if (listener) listener(request);
  else pendingRequest = request;
}
export function appAlert(title: string, message?: string, actions: AppModalAction[] = [{ text: 'OK' }]) {
  showAppModal({ title, message, actions, variant: inferVariant(title, actions) });
}

const icons: Record<AppModalVariant, keyof typeof MaterialCommunityIcons.glyphMap> = {
  information: 'information-outline', success: 'check-circle-outline', error: 'alert-circle-outline', confirmation: 'help-circle-outline', destructive: 'alert-outline',
};
const iconColors: Record<AppModalVariant, string> = {
  information: theme.colors.cognacPressed, success: theme.colors.active.text, error: theme.colors.atRisk.text, confirmation: theme.colors.cognacPressed, destructive: theme.colors.atRisk.text,
};

export function AppModalHost() {
  const [request, setRequest] = useState<AppModalRequest | null>(null);
  const [busyAction, setBusyAction] = useState<number | null>(null);
  useEffect(() => {
    listener = value => { setBusyAction(null); setRequest(value); };
    if (pendingRequest) { setRequest(pendingRequest); pendingRequest = null; }
    return () => { listener = null; };
  }, []);
  if (!request) return null;
  const actions = request.actions?.length ? request.actions : [{ text: 'OK' }];
  const variant = request.variant ?? inferVariant(request.title, actions);
  const cancelIndex = actions.findIndex(action => action.style === 'cancel');
  const close = () => { if (busyAction === null) setRequest(null); };
  const run = async (action: AppModalAction, index: number) => {
    if (busyAction !== null) return;
    if (!action.onPress) { setRequest(null); return; }
    try {
      setBusyAction(index);
      await action.onPress();
      setRequest(current => current === request ? null : current);
    } finally { setBusyAction(null); }
  };
  return <Modal visible transparent animationType="fade" statusBarTranslucent onRequestClose={() => { if (cancelIndex >= 0 && busyAction === null) void run(actions[cancelIndex], cancelIndex); else close(); }}>
    <SafeAreaView style={s.overlay}><Pressable accessibilityLabel="Close dialog" style={StyleSheet.absoluteFill} onPress={cancelIndex >= 0 ? close : undefined} /><View accessibilityRole="alert" accessibilityViewIsModal style={s.card}>
      <View style={[s.icon, { backgroundColor: `${iconColors[variant]}18` }]}><MaterialCommunityIcons name={icons[variant]} size={27} color={iconColors[variant]} /></View>
      <ScrollView style={s.content} contentContainerStyle={s.contentInner} bounces={false}><Text style={s.title}>{request.title}</Text>{request.message ? <Text style={s.message}>{request.message}</Text> : null}</ScrollView>
      <View style={s.actions}>{actions.map((action, index) => { const primary = action.style !== 'cancel'; const destructive = action.style === 'destructive'; return <Pressable key={`${action.text}-${index}`} accessibilityRole="button" disabled={busyAction !== null} onPress={() => void run(action, index)} style={({ pressed }) => [s.action, primary ? s.primary : s.secondary, destructive && s.destructive, pressed && s.pressed, busyAction !== null && s.disabled]}>{busyAction === index ? <ActivityIndicator color="#FFFFFF" /> : <Text style={[s.actionText, !primary && s.secondaryText]}>{action.text}</Text>}</Pressable>; })}</View>
    </View></SafeAreaView>
  </Modal>;
}

const s = StyleSheet.create({ overlay:{flex:1,backgroundColor:'rgba(24,26,30,.48)',alignItems:'center',justifyContent:'center',padding:20},card:{width:'100%',maxWidth:420,maxHeight:'82%',backgroundColor:theme.colors.card,borderRadius:theme.radii.xl,padding:20,gap:14,...theme.shadow},icon:{width:48,height:48,borderRadius:15,alignItems:'center',justifyContent:'center'},content:{flexGrow:0},contentInner:{gap:7},title:{color:theme.colors.primary,fontFamily:theme.fonts.bold,fontSize:20,lineHeight:26},message:{color:theme.colors.secondary,fontFamily:theme.fonts.regular,fontSize:14,lineHeight:21},actions:{flexDirection:'row-reverse',flexWrap:'wrap',gap:9},action:{minHeight:48,minWidth:100,paddingHorizontal:16,borderRadius:theme.radii.input,alignItems:'center',justifyContent:'center'},primary:{backgroundColor:theme.colors.primary},secondary:{backgroundColor:theme.colors.card,borderWidth:1,borderColor:theme.colors.border},destructive:{backgroundColor:'#B42318'},actionText:{color:'#FFFFFF',fontFamily:theme.fonts.bold,fontSize:14},secondaryText:{color:theme.colors.primary},pressed:{opacity:.75},disabled:{opacity:.58} });
