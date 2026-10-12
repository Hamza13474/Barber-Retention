import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { supabase } from '../../lib/supabase';

const DEVICE_ID_KEY = 'barber-retention.push-device-id';

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export type ReminderPermission = 'granted' | 'denied' | 'undetermined' | 'unavailable';

export async function getReminderPermission(): Promise<ReminderPermission> {
  if (!Device.isDevice || Platform.OS === 'web') return 'unavailable';
  const result = await Notifications.getPermissionsAsync();
  return result.status as ReminderPermission;
}

const getDeviceId = () => {
  let value = globalThis.localStorage.getItem(DEVICE_ID_KEY);
  if (!value) {
    value = `${Platform.OS}-${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    globalThis.localStorage.setItem(DEVICE_ID_KEY, value);
  }
  return value;
};

export async function registerCurrentDevice(requestPermission: boolean) {
  if (!supabase || !Device.isDevice || Platform.OS === 'web') throw new Error('Push notifications require a physical iOS or Android device.');
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('reminders', { name: 'Appointment and return reminders', importance: Notifications.AndroidImportance.HIGH });
  }
  let permission = await Notifications.getPermissionsAsync();
  if (permission.status !== 'granted' && requestPermission) permission = await Notifications.requestPermissionsAsync();
  if (permission.status !== 'granted') throw new Error('Notification permission was not granted.');
  const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) throw new Error('Expo project ID is missing.');
  const token = await Notifications.getExpoPushTokenAsync({ projectId });
  const { error } = await supabase.rpc('register_push_device', {
    p_expo_push_token: token.data,
    p_device_id: getDeviceId(),
    p_platform: Platform.OS,
  });
  if (error) throw new Error('The device could not be registered.');
}

export async function deactivateCurrentDevice() {
  const deviceId = globalThis.localStorage.getItem(DEVICE_ID_KEY);
  if (!supabase || !deviceId) return;
  const { error } = await supabase.rpc('deactivate_push_device', { p_device_id: deviceId });
  if (error) throw new Error('The device registration could not be disabled.');
}

export async function releaseCurrentDevice() {
  const deviceId = globalThis.localStorage.getItem(DEVICE_ID_KEY);
  if (!supabase || !deviceId) return;
  const { error } = await supabase.rpc('release_push_device', { p_device_id: deviceId });
  if (error) throw new Error('The device registration could not be released.');
}

export function listenForReminderTaps(onRoute: (route: 'appointments' | 'booking', barberId?: string, serviceIds?: string[]) => void) {
  const useResponse = (response: Notifications.NotificationResponse | null) => {
    const data = response?.notification.request.content.data;
    if (data?.route === 'appointments') onRoute('appointments');
    if (data?.route === 'booking' && typeof data.barberId === 'string') {
      const serviceIds = Array.isArray(data.serviceIds) ? data.serviceIds.filter((id): id is string => typeof id === 'string') : [];
      onRoute('booking', data.barberId, serviceIds);
    }
  };
  void Notifications.getLastNotificationResponseAsync().then(response => {
    useResponse(response);
    if (response) void Notifications.clearLastNotificationResponseAsync();
  });
  const subscription = Notifications.addNotificationResponseReceivedListener(useResponse);
  return () => subscription.remove();
}
