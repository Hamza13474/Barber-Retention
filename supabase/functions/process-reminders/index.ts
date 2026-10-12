import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

type Claim = { id: string; claim_token: string };
type Prepared = { id: string; title: string; body: string; data: Record<string, unknown>; expo_push_tokens: string[] };
type ValidTicket = { status: 'ok'; id: string } | { status: 'error'; errorCode?: string };
type SendOutcome = { acceptedTicketIds: string[]; invalidTokens: string[]; retryableFailure: boolean };

const EXPO_BATCH_LIMIT = 100;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

const secureEqual = async (actual: string, expected: string) => {
  const encoder = new TextEncoder();
  const [actualHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(actual)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ]);
  const a = new Uint8Array(actualHash); const b = new Uint8Array(expectedHash);
  let difference = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) difference |= (a[index % a.length] ?? 0) ^ (b[index % b.length] ?? 0);
  return difference === 0;
};

const chunksOf = <T>(values: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
};

const parseTickets = (payload: unknown, expected: number): ValidTicket[] | null => {
  if (!payload || typeof payload !== 'object' || !('data' in payload)) return null;
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data) || data.length !== expected) return null;
  const tickets: ValidTicket[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== 'object' || !('status' in entry)) return null;
    const ticket = entry as { status?: unknown; id?: unknown; details?: unknown; message?: unknown };
    if (ticket.status === 'ok') {
      if (typeof ticket.id !== 'string' || ticket.id.length === 0) return null;
      tickets.push({ status: 'ok', id: ticket.id });
    } else if (ticket.status === 'error') {
      if (typeof ticket.message !== 'string' || ticket.message.length === 0) return null;
      const details = ticket.details;
      const errorCode = details && typeof details === 'object' && typeof (details as { error?: unknown }).error === 'string'
        ? (details as { error: string }).error : undefined;
      tickets.push({ status: 'error', errorCode });
    } else return null;
  }
  return tickets;
};

async function sendExpo(prepared: Prepared): Promise<SendOutcome> {
  const acceptedTicketIds: string[] = []; const invalidTokens: string[] = [];
  let retryableFailure = false;
  const expoAccessToken = Deno.env.get('EXPO_ACCESS_TOKEN');
  for (const tokens of chunksOf(prepared.expo_push_tokens, EXPO_BATCH_LIMIT)) {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (expoAccessToken) headers.authorization = `Bearer ${expoAccessToken}`;
    let response: Response;
    try {
      response = await fetch('https://exp.host/--/api/v2/push/send', {
        method: 'POST', headers,
        body: JSON.stringify(tokens.map(to => ({ to, title: prepared.title, body: prepared.body, data: prepared.data, sound: 'default', priority: 'high', channelId: 'reminders' }))),
      });
    } catch { retryableFailure = true; continue; }
    if (!response.ok) { retryableFailure = true; continue; }
    let payload: unknown;
    try { payload = await response.json(); } catch { retryableFailure = true; continue; }
    const tickets = parseTickets(payload, tokens.length);
    if (!tickets) { retryableFailure = true; continue; }
    tickets.forEach((ticket, index) => {
      if (ticket.status === 'ok') acceptedTicketIds.push(ticket.id);
      else if (ticket.errorCode === 'DeviceNotRegistered') invalidTokens.push(tokens[index]);
      else retryableFailure = true;
    });
  }
  return { acceptedTicketIds, invalidTokens, retryableFailure };
}

async function failClaim(supabase: SupabaseClient, claim: Claim, reason: string, retry: boolean) {
  const result = await supabase.rpc('fail_reminder_delivery', {
    p_reminder_id: claim.id, p_claim_token: claim.claim_token, p_error: reason, p_retry: retry,
  });
  return !result.error && result.data === true;
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  const workerSecret = Deno.env.get('REMINDER_WORKER_SECRET');
  const suppliedSecret = request.headers.get('x-reminder-worker-secret') ?? '';
  if (!workerSecret || workerSecret.length < 32 || !await secureEqual(suppliedSecret, workerSecret)) return json({ error: 'Unauthorized' }, 401);
  const url = Deno.env.get('SUPABASE_URL'); const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return json({ error: 'Server configuration is incomplete' }, 500);

  const supabase = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const generated = await supabase.rpc('generate_due_reminders');
  if (generated.error || typeof generated.data !== 'number') return json({ error: 'Reminder generation failed' }, 500);
  const claimed = await supabase.rpc('claim_due_reminders', { p_limit: 50 });
  if (claimed.error || !Array.isArray(claimed.data)) return json({ error: 'Reminder claim failed' }, 500);

  const results: Array<{ id: string; outcome: string }> = [];
  for (const rawClaim of claimed.data as unknown[]) {
    const claim = rawClaim as Partial<Claim>;
    if (typeof claim?.id !== 'string' || typeof claim?.claim_token !== 'string') { console.error('Malformed reminder claim returned by database'); continue; }
    let expoAccepted = false;
    try {
      const prepared = await supabase.rpc('prepare_reminder_delivery', { p_reminder_id: claim.id, p_claim_token: claim.claim_token });
      if (prepared.error || !Array.isArray(prepared.data)) {
        const finalized = await failClaim(supabase, claim as Claim, 'Preparation RPC failed', true);
        if (!finalized) console.error('Reminder failure finalization failed', { reminderId: claim.id });
        results.push({ id: claim.id, outcome: finalized ? 'retry' : 'finalization_failed' }); continue;
      }
      if (prepared.data.length === 0) { results.push({ id: claim.id, outcome: 'suppressed' }); continue; }
      if (prepared.data.length !== 1) {
        const finalized = await failClaim(supabase, claim as Claim, 'Malformed preparation result', true);
        if (!finalized) console.error('Reminder failure finalization failed', { reminderId: claim.id });
        results.push({ id: claim.id, outcome: finalized ? 'retry' : 'finalization_failed' }); continue;
      }
      const item = prepared.data[0] as Partial<Prepared>;
      if (item.id !== claim.id || typeof item.title !== 'string' || typeof item.body !== 'string' || !item.data || typeof item.data !== 'object'
          || !Array.isArray(item.expo_push_tokens) || item.expo_push_tokens.some(token => typeof token !== 'string')) {
        const finalized = await failClaim(supabase, claim as Claim, 'Malformed preparation payload', true);
        if (!finalized) console.error('Reminder failure finalization failed', { reminderId: claim.id });
        results.push({ id: claim.id, outcome: finalized ? 'retry' : 'finalization_failed' }); continue;
      }
      if (item.expo_push_tokens.length === 0) {
        const finalized = await failClaim(supabase, claim as Claim, 'No active push registration', false);
        if (!finalized) console.error('Reminder failure finalization failed', { reminderId: claim.id });
        results.push({ id: claim.id, outcome: finalized ? 'no_device' : 'finalization_failed' }); continue;
      }

      const outcome = await sendExpo(item as Prepared);
      for (const token of outcome.invalidTokens) {
        const deactivated = await supabase.rpc('deactivate_push_token', { p_expo_push_token: token });
        if (deactivated.error || deactivated.data !== true) console.error('Push-token deactivation failed', { reminderId: claim.id });
      }

      // Deliberate partial-success policy: any valid Expo acceptance finishes the
      // reminder because retrying would duplicate messages accepted for other devices.
      if (outcome.acceptedTicketIds.length > 0) {
        expoAccepted = true;
        const finished = await supabase.rpc('finish_reminder_delivery', {
          p_reminder_id: claim.id, p_claim_token: claim.claim_token, p_ticket_ids: outcome.acceptedTicketIds,
        });
        if (finished.error || finished.data !== true) {
          // Expo and Postgres cannot share a transaction. Lease recovery may send
          // a duplicate after this acceptance/finalization boundary failure.
          console.error('Reminder success finalization failed after Expo acceptance', { reminderId: claim.id });
          results.push({ id: claim.id, outcome: 'accepted_finalization_failed' });
        } else results.push({ id: claim.id, outcome: 'delivered' });
        continue;
      }

      const retry = outcome.retryableFailure;
      const finalized = await failClaim(supabase, claim as Claim, retry ? 'Expo request or response failed validation' : 'All device tokens were rejected', retry);
      if (!finalized) console.error('Reminder failure finalization failed', { reminderId: claim.id });
      results.push({ id: claim.id, outcome: finalized ? (retry ? 'retry' : 'invalid_devices') : 'finalization_failed' });
    } catch {
      if (expoAccepted) {
        // Do not deliberately requeue after acceptance. Leave the owned lease for
        // normal recovery because the database outcome is unknown.
        console.error('Unexpected failure after Expo acceptance', { reminderId: claim.id });
        results.push({ id: claim.id, outcome: 'accepted_finalization_failed' });
        continue;
      }
      const finalized = await failClaim(supabase, claim as Claim, 'Unexpected reminder processing failure', true);
      if (!finalized) console.error('Unexpected reminder failure could not be finalized', { reminderId: claim.id });
      results.push({ id: claim.id, outcome: finalized ? 'retry' : 'finalization_failed' });
    }
  }
  return json({ generated: generated.data, claimed: claimed.data.length, results });
});
