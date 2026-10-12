import DateTimePicker, { type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { MaterialCommunityIcons } from '@expo/vector-icons';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

export function DateTimeField({ label, value, mode, onChange, minimumDate }: { label: string; value: Date; mode: 'date' | 'time'; onChange: (value: Date) => void; minimumDate?: Date }) {
  const [open, setOpen] = useState(false);
  const select = (event: DateTimePickerEvent, next?: Date) => {
    if (Platform.OS === 'android') setOpen(false);
    if (event.type === 'set' && next) onChange(next);
  };
  const display = mode === 'date' ? value.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }) : value.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return <View style={styles.field}><Text style={styles.label}>{label}</Text><Pressable accessibilityRole="button" onPress={() => setOpen(true)} style={({ pressed }) => [styles.control, pressed && styles.pressed]}><MaterialCommunityIcons name={mode === 'date' ? 'calendar-month-outline' : 'clock-outline'} size={20} color={theme.colors.cognacPressed} /><Text style={styles.value}>{display}</Text><MaterialCommunityIcons name="chevron-down" size={20} color={theme.colors.secondary} /></Pressable>{open ? <View style={styles.pickerWrap}><DateTimePicker value={value} mode={mode} display={Platform.OS === 'ios' ? (mode === 'date' ? 'inline' : 'spinner') : 'default'} minimumDate={minimumDate} minuteInterval={5} onChange={select} />{Platform.OS === 'ios' ? <Pressable style={styles.done} onPress={() => setOpen(false)}><Text style={styles.doneText}>Done</Text></Pressable> : null}</View> : null}</View>;
}

const styles = StyleSheet.create({ field: { flex: 1, gap: 6 }, label: { color: theme.colors.secondary, fontFamily: theme.fonts.semibold, fontSize: 13 }, control: { minHeight: 50, paddingHorizontal: 13, flexDirection: 'row', alignItems: 'center', gap: 9, backgroundColor: theme.colors.card, borderWidth: 1, borderColor: theme.colors.border, borderRadius: theme.radii.input }, value: { flex: 1, color: theme.colors.primary, fontFamily: theme.fonts.semibold, fontSize: 14 }, pressed: { opacity: .72 }, pickerWrap: { padding: 8, backgroundColor: theme.colors.card, borderRadius: theme.radii.input, borderWidth: 1, borderColor: theme.colors.border }, done: { minHeight: 42, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.primary, borderRadius: 10 }, doneText: { color: theme.colors.card, fontFamily: theme.fonts.bold } });
