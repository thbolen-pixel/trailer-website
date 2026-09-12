// Vercel serverless function: POST /api/book
// Saves the booking to Supabase (using the SECRET service role key, which
// bypasses row-level security) and emails the owner via Resend.
//
// Required environment variables (set these in Vercel -> Settings -> Environment Variables):
//   SUPABASE_URL                - same URL as in supabase-config.js
//   SUPABASE_SERVICE_ROLE_KEY   - Supabase Settings -> API -> service_role key (SECRET, never expose client-side)
//   RESEND_API_KEY              - from resend.com dashboard -> API Keys (SECRET)
//   RESEND_FROM_EMAIL           - the sending address, e.g. bookings@alloccasioncamping.com
//                                  (must be on a domain you've verified in Resend — see SETUP.md)
//   OWNER_EMAIL                 - your mother's email to notify, e.g. yourmom@example.com

const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { start_date, end_date, guest_name, guest_email, guest_phone, notes, user_id } = req.body;

  if (!start_date || !end_date || !guest_name || !guest_email || !guest_phone) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { data: overlapping, error: overlapErr } = await supabaseAdmin
    .from('bookings')
    .select('id')
    .lte('start_date', end_date)
    .gte('end_date', start_date);

  if (overlapErr) {
    return res.status(500).json({ error: 'Could not check availability.' });
  }
  if (overlapping && overlapping.length > 0) {
    return res.status(409).json({ error: 'Those dates were just taken. Please pick different dates.' });
  }

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from('bookings')
    .insert({
      start_date, end_date, guest_name, guest_email, guest_phone, notes,
      user_id: user_id || null,
      is_blocked: false
    })
    .select()
    .single();

  if (insertErr) {
    return res.status(500).json({ error: 'Could not save booking.' });
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.RESEND_FROM_EMAIL,
      to: process.env.OWNER_EMAIL,
      subject: `New trailer booking request: ${start_date} to ${end_date}`,
      text: `New trailer booking request!\n\nName: ${guest_name}\nDates: ${start_date} to ${end_date}\nPhone: ${guest_phone}\nEmail: ${guest_email}${notes ? '\nNotes: ' + notes : ''}`
    });
  } catch (emailErr) {
    console.error('Resend email failed:', emailErr.message);
  }

  return res.status(200).json({ success: true, booking: inserted });
};
