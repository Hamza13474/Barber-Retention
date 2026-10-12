export type Role = 'barber' | 'customer';

export type Profile = {
  id: string; role: Role; full_name: string; email: string; phone: string | null; avatar_url: string | null;
  display_name: string | null; bio: string | null; address: string | null; city: string | null; postcode: string | null; business_phone: string | null; working_days: string | null; opening_time: string | null; closing_time: string | null; timezone: string | null;
  notifications_enabled: boolean | null;
};

export type Service = {
  id: string;
  barber_id: string;
  name: string;
  description: string | null;
  price: number;
  duration_minutes: number;
  recommended_return_days: number | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type WeeklyAvailability = { id: string; barber_id: string; weekday: number; start_time: string; end_time: string; created_at: string; updated_at: string };
export type BlockedPeriod = { id: string; barber_id: string; start_at: string; end_at: string; reason: string | null; created_at: string; updated_at: string };
export type BarberSummary = { id: string; display_name: string; city: string | null; avatar_url: string | null; timezone: string };
export type CustomerBusiness = BarberSummary;
export type AppointmentStatus = 'booked' | 'cancelled_by_customer' | 'cancelled_by_barber' | 'completed' | 'no_show';
export type AppointmentService = { id: string; appointment_id: string; service_id: string; service_name: string; price: number; duration_minutes: number; recommended_return_days: number | null; created_at: string };
export type Appointment = { id: string; barber_id: string; customer_id: string; start_at: string; end_at: string; status: AppointmentStatus; total_duration_minutes: number; estimated_total: number; created_at: string; updated_at: string; completed_at: string | null; appointment_services?: AppointmentService[] };
export type CustomerAppointment = Pick<Appointment, 'id' | 'barber_id' | 'start_at' | 'end_at' | 'status' | 'total_duration_minutes' | 'estimated_total'> & { barber_name: string; barber_timezone: string; services: AppointmentService[] };
export type CalendarAppointment = Omit<Appointment, 'barber_id' | 'customer_id' | 'appointment_services'> & { customer_name: string; services: AppointmentService[] };
export type CalendarView = 'day' | 'week' | 'month';
export type GetAvailableSlotsArgs = { p_barber_id: string; p_date: string; p_service_ids: string[] };
export type LoyaltyTransactionType = 'appointment_earned' | 'reward_redeemed' | 'referral_earned';
export type LoyaltyReward = { id: string; barber_id?: string; title: string; description: string | null; points_required: number; is_active: boolean; created_at: string; updated_at: string };
export type LoyaltyHistoryItem = { id: string; amount: number; transaction_type: LoyaltyTransactionType; description: string; created_at: string };
export type CustomerLoyaltyAccount = { barber_id: string; barber_name: string; balance: number; rewards: LoyaltyReward[]; history: LoyaltyHistoryItem[] };
export type BarberLoyaltyCustomer = { customer_id: string; customer_name: string; balance: number; last_appointment_at: string | null };
export type BarberCustomerLoyalty = { customer_id: string; customer_name: string; balance: number; history: LoyaltyHistoryItem[] };
export type ReferralStatus = 'pending' | 'rewarded';
export type ReferralActivity = { id: string; status: ReferralStatus; claimed_at: string; qualified_at: string | null; reward_points: number };
export type CustomerReferralOverview = { barber_id: string; barber_name: string; referral_code: string; reward_points: number; activity: ReferralActivity[] };
export type ClaimedReferral = { barber_id: string; barber_name: string; status: ReferralStatus };
export type BarberCustomer = { customer_id: string; customer_name: string; avatar_url: string | null; first_completed_at: string; last_completed_at: string; completed_visit_count: number; completed_value: number; loyalty_points: number; last_services: string; last_recommended_return_days: number | null };
export type BarberCustomerServiceSnapshot = Pick<AppointmentService, 'service_id' | 'service_name' | 'price' | 'duration_minutes' | 'recommended_return_days'>;
export type BarberCustomerVisit = { id: string; start_at: string; estimated_total: number; services: BarberCustomerServiceSnapshot[] };
export type BarberCustomerDetail = Omit<BarberCustomer, 'last_services'> & { last_services: BarberCustomerServiceSnapshot[]; recent_visits: BarberCustomerVisit[] };
export type RetentionStatus = 'ACTIVE' | 'DUE_SOON' | 'OVERDUE' | 'AT_RISK';
export type RetentionActionableStatus = RetentionStatus | 'BOOKED';
export type BarberRetentionCustomer = {
  customer_id: string;
  customer_name: string;
  avatar_url: string | null;
  last_completed_at: string;
  last_services: string;
  recommended_return_days: number | null;
  expected_return_date: string | null;
  retention_status: RetentionStatus | null;
  actionable_status: RetentionActionableStatus | null;
  days_relative_to_expected: number | null;
  next_booked_at: string | null;
};
