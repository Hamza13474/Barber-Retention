import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, AppState, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { appAlert } from '../../components/AppModal';
import { theme } from '../../theme';
import { deactivateCurrentDevice, getReminderPermission, registerCurrentDevice, type ReminderPermission } from './notifications';

export function NotificationPreferences() {
  const [permission, setPermission] = useState<ReminderPermission>('undetermined');
  const [registered, setRegistered] = useState(false);
  const [registrationFailed, setRegistrationFailed] = useState(false);
  const [busy, setBusy] = useState(true);

  const refresh = useCallback(async () => {
    const status = await getReminderPermission();
    setPermission(status);
    if (status !== 'granted') {
      if (status === 'denied') {
        try { await deactivateCurrentDevice(); } catch { /* OS denial still controls delivery on this device. */ }
      }
      setRegistered(false);
      setRegistrationFailed(false);
      return;
    }
    try {
      await registerCurrentDevice(false);
      setRegistered(true);
      setRegistrationFailed(false);
    } catch {
      setRegistered(false);
      setRegistrationFailed(true);
    }
  }, []);

  useEffect(() => {
    setBusy(true);
    void refresh().finally(() => setBusy(false));
  }, [refresh]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active') void refresh();
    });
    return () => subscription.remove();
  }, [refresh]);

  const enable = async () => {
    setBusy(true);
    try {
      await registerCurrentDevice(permission === 'undetermined');
      setPermission('granted');
      setRegistered(true);
      setRegistrationFailed(false);
    } catch (error) {
      setRegistered(false);
      setRegistrationFailed(true);
      setPermission(await getReminderPermission());
      appAlert('Notifications not enabled', error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const status = permission === 'denied' ? 'Off in phone settings'
    : permission === 'unavailable' ? 'Unavailable on this device'
    : permission !== 'granted' ? 'Permission needed'
    : registrationFailed || !registered ? 'Device registration unavailable'
    : 'Enabled';

  return <View style={s.card}>
    <Text style={s.title}>Notifications</Text>
    {busy ? <ActivityIndicator color="#D9A441" /> : <>
      <Text style={s.status}>{status}</Text>
      <Text style={s.body}>Appointment and return reminders are included with the Barber App.</Text>
      {permission === 'denied' ? <Pressable onPress={() => void Linking.openSettings()}><Text style={s.link}>Open phone settings</Text></Pressable>
        : permission === 'unavailable' ? <Text style={s.note}>Push notifications require a physical iOS or Android development build.</Text>
        : permission !== 'granted' ? <Pressable style={s.button} onPress={() => void enable()}><Text style={s.buttonText}>Enable notifications</Text></Pressable>
        : !registered ? <Pressable style={s.button} onPress={() => void enable()}><Text style={s.buttonText}>Retry device registration</Text></Pressable>
        : null}
    </>}
  </View>;
}

const s = StyleSheet.create({ card:{backgroundColor:theme.colors.card,borderWidth:1,borderColor:theme.colors.border,borderRadius:theme.radii.card,padding:16,gap:9,...theme.shadow},title:{color:theme.colors.primary,fontFamily:theme.fonts.bold,fontSize:18},status:{color:theme.colors.booked.text,fontFamily:theme.fonts.bold,fontSize:13},body:{color:theme.colors.secondary,fontFamily:theme.fonts.regular,fontSize:13,lineHeight:19},note:{color:theme.colors.secondary,fontFamily:theme.fonts.regular,fontSize:12,lineHeight:18},link:{minHeight:44,color:theme.colors.cognacPressed,fontFamily:theme.fonts.bold,textAlignVertical:'center'},button:{minHeight:46,alignItems:'center',justifyContent:'center',backgroundColor:theme.colors.primary,borderRadius:theme.radii.input,paddingHorizontal:14},buttonText:{color:'#FFFFFF',fontFamily:theme.fonts.bold} });
