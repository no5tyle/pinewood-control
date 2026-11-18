// Screenshots for Pinewood Control's page on qstored.org (no5tyle/qstored: shots/pinewood-control, made into site/img/products/pinewood-control), from a demo
// derby on the local API (Firebase emulators, started fresh). Run the backend (`npm run dev` in backend/) and the
// frontend (`VITE_FIREBASE_API_KEY=fake VITE_AUTH_EMULATOR_HOST=127.0.0.1:9099 npx vite --port 5173` in frontend/),
// then:
//
//   node scripts/product-shots.cjs ../qstored/shots/pinewood-control
//
// Then in no5tyle/qstored: `python3 scripts/product-images.py` makes them the right size for the site.
const { chromium, devices } = require('playwright');

const OUT = process.argv[2] || 'product-shots';
const BASE = 'http://localhost:5173';
const AUTH = 'http://127.0.0.1:9099';
const PROJECT = 'demo-qstored';
const CUBS = [
  ['Ada', 'Wolf Six'], ['Bo', 'Wolf Six'], ['Charlie', 'Bear Six'], ['Di', 'Bear Six'], ['Eli', 'Fox Six'], ['Freya', 'Fox Six'],
  ['Gus', 'Eagle Six'], ['Hana', 'Eagle Six'], ['Isla', 'Wolf Six'], ['Jack', 'Bear Six'], ['Kai', 'Fox Six'], ['Lily', 'Eagle Six'],
];

(async () => {
  const b = await chromium.launch({ args: ['--lang=en-AU'] });
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, locale: 'en-AU', colorScheme: 'light' });
  // The first-visit Quick Start box, already seen
  await ctx.addInitScript(() => localStorage.setItem('pinewood_quickstart_dismissed_v1', '1'));
  const p = await ctx.newPage();
  p.setDefaultTimeout(15000);
  const shot = async (page, name, opts = {}) => { await page.waitForTimeout(600); await page.screenshot({ path: `${OUT}/${name}.png`, ...opts }); console.log(name); };

  await p.goto(`${BASE}/`);
  await p.waitForSelector('h1');
  await shot(p, 'home');

  // Sign in as Akela by email link
  await p.goto(`${BASE}/login`);
  await p.fill('input[type=email]', 'akela@example.com');
  await p.click('text=Email me a sign-in link');
  await p.waitForSelector("text=We've sent a sign-in link");
  const codes = await (await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`)).json();
  const link = new URL(codes.oobCodes.at(-1).oobLink);
  const cont = new URL(link.searchParams.get('continueUrl'));
  cont.searchParams.set('mode', 'signIn'); cont.searchParams.set('oobCode', link.searchParams.get('oobCode'));
  await p.goto(cont.toString());
  await p.waitForURL(/\/events/);

  const api = (path, method = 'GET', body) => p.evaluate(async ([path, method, body]) => {
    const { api } = await import('/src/shared/api.ts');
    return api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) });
  }, [path, method, body]);

  // A Race Patrol of the Cub pack, and saved setups
  const patrol = await api('/patrols', 'POST', { name: '1st Wattle Creek Cubs', racers: CUBS.map(([name, groupName]) => ({ name, groupName, weight: 138 + Math.round(Math.random() * 40) / 10 })) });
  await api('/patrols', 'POST', { name: 'Leaders', racers: [{ name: 'Akela' }, { name: 'Baloo' }, { name: 'Kaa' }, { name: 'Raksha' }] });
  await api('/race-setups', 'POST', { name: 'Hall track, 4 lanes', pointLimit: 3, lanes: 4, theme: 'system', weightUnit: 'g' });
  await api('/race-setups', 'POST', { name: 'District derby', pointLimit: 4, lanes: 6, theme: 'system', weightUnit: 'g' });

  // The derby: racers from the patrol, then heats
  const event = await api('/events', 'POST', { name: 'Cub Pinewood Derby 2026', lanes: 4, pointLimit: 3 });
  await api(`/events/${event.id}/scouts/import-patrols`, 'POST', { patrolIds: [patrol.id] });
  await api(`/events/${event.id}`, 'PATCH', { setupComplete: true });
  const race = async (heats) => {
    for (let i = 0; i < heats; i++) {
      const heat = await api(`/events/${event.id}/next-heat`, 'POST');
      const order = [...heat.laneAssignments].sort(() => Math.random() - 0.5);
      const laneTimes = Object.fromEntries(order.map((sid, k) => [sid, Math.round((2.9 + 0.07 * k + Math.random() * 0.04) * 1000) / 1000]));
      await api(`/events/${event.id}/heats/${heat.id}/result`, 'POST', { finishOrder: order, laneTimes });
    }
  };
  await race(5);
  await api(`/events/${event.id}/next-heat`, 'POST');
  await api('/events', 'POST', { name: 'Scout Gravity Grand Prix', lanes: 6, pointLimit: 4 });

  await p.goto(`${BASE}/events`);
  await p.waitForSelector('text=Cub Pinewood Derby 2026');
  await shot(p, 'events');
  await p.goto(`${BASE}/patrols`);
  await p.waitForSelector('text=1st Wattle Creek Cubs');
  await shot(p, 'patrols');
  await p.goto(`${BASE}/setups`);
  await p.waitForSelector('text=Hall track, 4 lanes');
  await shot(p, 'setups');

  // The big screen: pairing a phone, then a heat
  await p.goto(`${BASE}/kiosk/${event.id}`);
  await p.waitForSelector('text=Pair Operator');
  await shot(p, 'kiosk-pair');
  await p.locator('button[aria-label*="lose" i], button:has-text("×")').first().click().catch(() => {});
  await p.waitForTimeout(500);
  await shot(p, 'kiosk-heat');

  // Race Control on a phone
  const phone = await b.newContext({ ...devices['iPhone 13'], locale: 'en-AU' });
  await phone.addCookies(await ctx.cookies());
  const q = await phone.newPage();
  await q.goto(`${BASE}/`);
  await q.evaluate((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, await p.evaluate(() => Object.fromEntries(Object.entries(localStorage))));
  await q.goto(`${BASE}/control/${event.id}`);
  await q.waitForSelector('.heat-finisher-btn');
  await q.locator('.heat-finisher-btn').first().click();
  await shot(q, 'control-phone');
  // The popular vote, further down Race Control
  await q.evaluate(() => document.querySelector('.popular-vote-btn')?.scrollIntoView({ block: 'center' }));
  await shot(q, 'control-vote');

  // The heat's result: the big screen shows the winner
  const kioskWinner = p.waitForSelector('text=Heat winner', { timeout: 20000 }).catch(() => null);
  const current = (await api(`/events/${event.id}`)).heats.at(-1);
  const order = [...current.laneAssignments];
  await api(`/events/${event.id}/heats/${current.id}/result`, 'POST', { finishOrder: order, laneTimes: Object.fromEntries(order.map((sid, k) => [sid, 2.91 + k * 0.06])) });
  if (await kioskWinner) await shot(p, 'kiosk-winner');

  // To the end, with the popular vote
  for (;;) {
    const e = await api(`/events/${event.id}`);
    if (e.scouts.filter((s) => !s.eliminated).length <= 1) break;
    try { await race(1); } catch { break; }
  }
  const scouts = (await api(`/events/${event.id}`)).scouts;
  for (const n of ['Freya', 'Freya', 'Kai', 'Freya', 'Hana']) {
    await api(`/events/${event.id}/popular-vote`, 'POST', { favoriteScoutId: scouts.find((s) => s.name === n).id }).catch(() => {});
  }
  await api(`/events/${event.id}/popular-vote/reveal`, 'POST').catch(() => {});
  await p.waitForTimeout(5000);
  await p.goto(`${BASE}/results/${event.id}`);
  await p.waitForSelector('text=Final Standings');
  await shot(p, 'results', { fullPage: false });
  await b.close();
  console.log('done');
})().catch((e) => { console.error(e); process.exit(1); });
