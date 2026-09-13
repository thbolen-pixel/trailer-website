// Vercel serverless function: GET /api/sync-outdoorsy
// Fetches your Outdoorsy iCal feed and mirrors those booked dates into
// Supabase as blocked dates (source = 'outdoorsy'), so your own booking
// calendar won't double-book against Outdoorsy reservations.
//
// Runs automatically once a day via vercel.json's cron entry, and can also
// be triggered manually (there's a "Sync Now" button for this on the
// Manager Dashboard).
//
// Required environment variables:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   OUTDOORSY_ICS_URL   - the calendar export link from Outdoorsy's Calendar Sync tools

const { createClient } = require('@supabase/supabase-js');

function toIsoDate(yyyymmdd) {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

function subtractOneDay(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function parseIcs(text) {
  const events = [];
  const blocks = text.split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const uidMatch = block.match(/UID:(.+)/);
    const startMatch = block.match(/DTSTART[^:]*:(\d{8})/);
    const endMatch = block.match(/DTEND[^:]*:(\d{8})/);
    if (!uidMatch || !startMatch || !endMatch) continue;

    const uid = uidMatch[1].trim();
    const startDate = toIsoDate(startMatch[1]);
    // DTEND in all-day iCal events is exclusive (the checkout/turnaround day),
    // so the last actually-occupied night is one day earlier.
    const endDate = subtractOneDay(toIsoDate(endMatch[1]));

    events.push({ uid, startDate, endDate });
  }
  return events;
}

module.exports = async (req, res) => {
  const icsUrl = process.env.OUTDOORSY_ICS_URL;
  if (!icsUrl) {
    return res.status(500).json({ error: 'OUTDOORSY_ICS_URL is not set.' });
  }

  let events;
  try {
    const icsResponse = await fetch(icsUrl);
    const text = await icsResponse.text();
    events = parseIcs(text);
  } catch (err) {
    return res.status(500).json({ error: 'Could not fetch or parse the Outdoorsy calendar.' });
  }

  const supabaseAdmin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  for (const ev of events) {
    if (ev.endDate < ev.startDate) continue; // skip zero-length/malformed events
    await supabaseAdmin.from('bookings').upsert(
      {
        external_uid: ev.uid,
        start_date: ev.startDate,
        end_date: ev.endDate,
        is_blocked: true,
        source: 'outdoorsy',
        notes: 'Synced from Outdoorsy'
      },
      { onConflict: 'external_uid' }
    );
  }

  // Remove previously-synced Outdoorsy blocks that no longer appear in the feed
  // (covers cancellations on Outdoorsy's end).
  const currentUids = events.map(e => e.uid);
  const { data: existingOutdoorsy } = await supabaseAdmin
    .from('bookings')
    .select('id, external_uid')
    .eq('source', 'outdoorsy');

  const staleIds = (existingOutdoorsy || [])
    .filter(row => row.external_uid && !currentUids.includes(row.external_uid))
    .map(row => row.id);

  if (staleIds.length > 0) {
    await supabaseAdmin.from('bookings').delete().in('id', staleIds);
  }

  return res.status(200).json({ synced: events.length, removed: staleIds.length });
};
