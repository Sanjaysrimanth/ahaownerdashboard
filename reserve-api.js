/* ═══════════════════════════════════════════════════════════════
   reserve-api.js — Backend Integration Layer
   Connects the existing reservation wizard UI (reserve.js)
   to the Google Apps Script Web App backend.

   HOW TO USE:
   In reserve.html, load scripts in this order:
     <script src="js/main.js"></script>
     <script src="js/reserve.js"></script>
     <script src="js/reserve-api.js"></script>  ← add this last

   Then replace YOUR_APPS_SCRIPT_WEB_APP_URL_HERE below
   with the URL from your Apps Script deployment.
═══════════════════════════════════════════════════════════════ */

/* ─────────────────────────────────────────────────────────────
   CONFIG — paste your deployed Apps Script Web App URL here
───────────────────────────────────────────────────────────────*/
const RESERVE_API_URL = 'https://script.google.com/macros/s/AKfycbxCvG16NhAtmHc33FX5hwNgan7szrROlvOKqjvpq85kUHY5Xpu3opqYFGN2Ju5mUgdl/exec';

/* ─────────────────────────────────────────────────────────────
   API STATE
───────────────────────────────────────────────────────────────*/
let API_BRANCHES       = [];          // branches loaded from API
let API_SLOTS          = [];          // raw slot array from API for selected date
let API_BOOKING_REF    = '';          // returned booking ref after createReservation
let API_SLOTS_LOADING  = false;       // prevent double-fetch
let API_BRANCH_PAUSED  = false;       // whether selected branch is paused

/* ─────────────────────────────────────────────────────────────
   UTILITY — generic fetch wrapper
───────────────────────────────────────────────────────────────*/
async function reserveApiCall(action, body = {}) {
  const response = await fetch(RESERVE_API_URL, {
    method:  'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8'
    },
    body:    JSON.stringify({ action, ...body })
  });
  if (!response.ok) throw new Error('Network error: ' + response.status);
  return response.json();
}

/* ─────────────────────────────────────────────────────────────
   TIME HELPERS
───────────────────────────────────────────────────────────────*/
function apiTimeToMins(t) {
  if (!t) return 0;
  const s    = t.toString().trim().toUpperCase();
  const isPM = s.includes('PM');
  const pts  = s.replace('AM','').replace('PM','').trim().split(':');
  let h = parseInt(pts[0], 10), m = parseInt(pts[1] || 0, 10);
  if (isPM && h < 12) h += 12;
  if (!isPM && h === 12) h = 0;
  return h * 60 + m;
}

/* ─────────────────────────────────────────────────────────────
   SLOT CATEGORISATION
   Splits a flat API slots array into the three session groups
   that the existing reserve.js buildTimeSlots() expects.
───────────────────────────────────────────────────────────────*/
function categoriseSlots(slots) {
  const LUNCH   = { min: 720,  max: 900  };  // 12:00 – 15:00
  const EVENING = { min: 900,  max: 1140 };  // 15:00 – 19:00
  const DINNER  = { min: 1140, max: 1440 };  // 19:00 – 24:00

  const lunch = [], evening = [], dinner = [];
  (slots || []).forEach(slot => {
    const mins = apiTimeToMins(slot.time);
    const obj  = { t: slot.time, avail: slot.available };
    if      (mins >= LUNCH.min   && mins < LUNCH.max)   lunch.push(obj);
    else if (mins >= EVENING.min && mins < EVENING.max) evening.push(obj);
    else if (mins >= DINNER.min)                         dinner.push(obj);
  });
  return { lunch, evening, dinner };
}

/* ─────────────────────────────────────────────────────────────
   INJECT LOADING INDICATOR INTO TIME SLOTS SECTION
───────────────────────────────────────────────────────────────*/
function showSlotsLoading() {
  ['slots-lunch','slots-evening','slots-dinner'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<div style="color:rgba(247,245,242,.3);font-size:12px;letter-spacing:1px;padding:8px 0;">Loading availability…</div>';
  });
}

function showSlotsError(msg) {
  ['slots-lunch','slots-evening','slots-dinner'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '<div style="color:rgba(140,29,24,.9);font-size:12px;padding:8px 0;">⚠ ' + msg + '</div>';
  });
}

/* ─────────────────────────────────────────────────────────────
   INJECT PAUSE NOTICE into step 1 branch card area
───────────────────────────────────────────────────────────────*/
function showBranchPausedNotice(branchName, reason) {
  const existing = document.getElementById('branch-paused-notice');
  if (existing) existing.remove();
  const notice = document.createElement('div');
  notice.id = 'branch-paused-notice';
  notice.style.cssText = `
    background:rgba(140,29,24,.12);border:1px solid rgba(140,29,24,.35);
    padding:16px 20px;margin-top:16px;font-size:13px;
    color:rgba(239,83,80,.9);line-height:1.7;
  `;
  notice.innerHTML = `
    <strong>🔴 ${branchName} is temporarily not accepting online reservations.</strong><br>
    <span style="font-size:12px;opacity:.8;">${reason || 'Please call us directly to make a reservation.'}</span><br>
    <span style="font-size:12px;color:rgba(199,154,59,.8);">📞 Call us: ${API_BRANCHES.find(b=>b.branchName===branchName)?.phone||'+91 891 234 5678'}</span>
  `;
  const grid = document.getElementById('branch-sel-grid');
  if (grid && grid.parentNode) grid.parentNode.insertBefore(notice, grid.nextSibling);
}

function clearBranchPausedNotice() {
  const el = document.getElementById('branch-paused-notice');
  if (el) el.remove();
}

/* ─────────────────────────────────────────────────────────────
   1. OVERRIDE buildBranchCards
   Replaces static cards with API-loaded branch data
───────────────────────────────────────────────────────────────*/
window.buildBranchCards = function () {
  const grid = document.getElementById('branch-sel-grid');
  if (!grid) return;

  if (!API_BRANCHES.length) {
    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:48px;color:rgba(247,245,242,.25);">
        <div style="font-size:28px;margin-bottom:10px;">⏳</div>
        Loading branches…
      </div>`;
    return;
  }

  grid.innerHTML = API_BRANCHES.map(b => `
    <div class="branch-sel-card" data-branch="${b.branchId}"
         onclick="selectBranch('${b.branchId}')">
      <div class="branch-sel-img">
        <img src="${getBranchImage(b.branchId)}" alt="${b.branchName}" loading="lazy">
      </div>
      <div class="branch-sel-info">
        <span class="branch-sel-badge">${b.badge || 'Branch'}</span>
        <div class="branch-sel-name">${b.branchName}</div>
        <div class="branch-sel-meta">
          ${b.address || ''}<br>
          <span style="color:var(--c-gold);font-size:10px;">⏱ ${b.hours || 'Mon–Sun: 11 AM – 11 PM'}</span>
        </div>
      </div>
    </div>`).join('');
};

/* branch image mapping — update paths as needed */
function getBranchImage(branchId) {
  const map = {
    default:     'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=500&q=80',
    VIZAG:       'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=500&q=80',
    GAJUWAKA:    'https://images.unsplash.com/photo-1537047902294-62a40c20a6ae?w=500&q=80',
    ANAKAPALLI:  'https://images.unsplash.com/photo-1555396273-367ea4eb4db5?w=500&q=80'
  };
  // Try partial match on branchId
  const key = Object.keys(map).find(k => branchId.toUpperCase().includes(k));
  return key ? map[key] : map.default;
}

/* ─────────────────────────────────────────────────────────────
   2. OVERRIDE selectBranch
   Patches STATE with full API branch data + checks pause status
───────────────────────────────────────────────────────────────*/
window.selectBranch = function (id) {
  const branch = API_BRANCHES.find(b => b.branchId === id);
  if (!branch) return;

  // Update STATE (the object is defined in reserve.js global scope)
  if (typeof STATE !== 'undefined') {
    STATE.branch        = id;
    STATE.branchName    = branch.branchName;
    STATE.branchAddress = branch.address || '';
  }

  // Highlight selected card
  document.querySelectorAll('.branch-sel-card').forEach(c =>
    c.classList.toggle('selected', c.dataset.branch === id)
  );

  clearBranchPausedNotice();

  // Check if branch is paused
  if (branch.paused) {
    API_BRANCH_PAUSED = true;
    showBranchPausedNotice(branch.branchName, branch.pauseReason);
    if (typeof updateSummary === 'function') updateSummary();
    return; // Do NOT advance to step 2
  }

  API_BRANCH_PAUSED = false;
  if (typeof clearError === 'function') clearError('branch-error');
  if (typeof updateSummary === 'function') updateSummary();

  // Auto-advance to step 2 after short delay
  setTimeout(() => {
    if (typeof goToStep === 'function') goToStep(2);
  }, 380);
};

/* ─────────────────────────────────────────────────────────────
   3. OVERRIDE selectDate
   Runs original date selection then fetches real API slots
───────────────────────────────────────────────────────────────*/
const _origSelectDate = window.selectDate;
window.selectDate = function (y, m, d) {
  // Run the original to update STATE, re-render calendar, update summary
  if (typeof _origSelectDate === 'function') _origSelectDate(y, m, d);

  // Then fetch real availability from API
  if (typeof STATE !== 'undefined' && STATE.branch) {
    const dateStr = y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    fetchAvailableSlots(STATE.branch, dateStr, STATE.guests || 2);
  }
};

/* ─────────────────────────────────────────────────────────────
   FETCH AVAILABLE SLOTS from API and rebuild the slot grids
───────────────────────────────────────────────────────────────*/
async function fetchAvailableSlots(branchId, dateStr, guests) {
  if (API_SLOTS_LOADING) return;
  API_SLOTS_LOADING = true;
  showSlotsLoading();

  console.log('REQUEST', {
    branchId,
    dateStr,
    guests
  });

  try {
    const data = await reserveApiCall(
      'getAvailableSlots',
      { branchId, date: dateStr, guests }
    );

    console.log('RESPONSE', data);

    if (!data.success) {
      showSlotsError(data.error || 'Could not load availability for this date.');
      API_SLOTS_LOADING = false;
      return;
    }

    API_SLOTS = data.slots || [];

    const { lunch, evening, dinner } = categoriseSlots(API_SLOTS);

    renderApiSlots('slots-lunch', lunch);
    renderApiSlots('slots-evening', evening);
    renderApiSlots('slots-dinner', dinner);

  } catch (e) {
    console.error('fetchAvailableSlots error:', e);
    showSlotsError('Unable to check availability. Please refresh and try again.');
  } finally {
    API_SLOTS_LOADING = false;
  }
}

/* ─────────────────────────────────────────────────────────────
   RENDER API SLOT BUTTONS
   Replaces static time-slot chips with API availability data
───────────────────────────────────────────────────────────────*/
function renderApiSlots(containerId, slots) {
  const el = document.getElementById(containerId);
  if (!el) return;

  if (!slots.length) {
    el.innerHTML = '<div style="font-size:12px;color:rgba(247,245,242,.25);padding:6px 0;">No slots in this session</div>';
    return;
  }

  el.innerHTML = slots.map(s => {
    const isSelected = typeof STATE !== 'undefined' && STATE.time === s.t;
    const cls = [
      'time-slot',
      !s.avail    ? 'unavailable' : '',
      isSelected  ? 'selected'    : ''
    ].filter(Boolean).join(' ');

    const unavailReason = !s.avail ? (s.reason || 'Unavailable') : '';
    return `
      <button
        class="${cls}"
        ${s.avail ? `onclick="selectTime('${s.t}')"` : 'disabled'}
        title="${s.avail ? s.t : unavailReason}"
        aria-label="${s.t}${!s.avail ? ' — ' + unavailReason : ''}"
      >${s.t}</button>`;
  }).join('');
}

/* ─────────────────────────────────────────────────────────────
   RE-RENDER SLOTS when time changes (to update selected state)
───────────────────────────────────────────────────────────────*/
const _origSelectTime = window.selectTime;
window.selectTime = function (t) {
  if (typeof _origSelectTime === 'function') _origSelectTime(t);
  // Re-render slots to reflect selected state
  if (API_SLOTS.length) {
    const { lunch, evening, dinner } = categoriseSlots(API_SLOTS);
    renderApiSlots('slots-lunch',   lunch);
    renderApiSlots('slots-evening', evening);
    renderApiSlots('slots-dinner',  dinner);
  }
};

/* ─────────────────────────────────────────────────────────────
   4. OVERRIDE FORM SUBMISSION
   Replaces the setTimeout simulation with real API createReservation
───────────────────────────────────────────────────────────────*/
document.addEventListener('DOMContentLoaded', () => {

  // ── Patch confirm submit button ─────────────────────────────
  // Use a timeout so reserve.js's DOMContentLoaded finishes first
  setTimeout(() => {
    const oldBtn = document.getElementById('confirm-submit');
    if (!oldBtn) return;

    // Replace node to remove all previous listeners
    const newBtn = oldBtn.cloneNode(true);
    oldBtn.parentNode.replaceChild(newBtn, oldBtn);

    newBtn.addEventListener('click', handleApiSubmit);
  }, 100);

  // ── Load branches from API ──────────────────────────────────
  loadBranchesFromApi();
});

/* ─────────────────────────────────────────────────────────────
   LOAD BRANCHES FROM API
───────────────────────────────────────────────────────────────*/
async function loadBranchesFromApi() {
  try {
    const data = await reserveApiCall('getBranches');
    if (!data.success || !data.branches?.length) {
      console.warn('reserve-api: no branches from API, using static fallback');
      return; // reserve.js static data will remain
    }

    // Enrich branches with extra display fields
    API_BRANCHES = data.branches.map(b => ({
      ...b,
      badge:  b.isMain ? 'Main Branch' : 'Branch',
      hours:  b.hours  || 'Mon–Sun: 11 AM – 11 PM',
      paused: b.paused || false,
      pauseReason: b.pauseReason || ''
    }));

    // Rebuild branch cards with API data
    if (typeof buildBranchCards === 'function') buildBranchCards();

  } catch (e) {
    console.warn('reserve-api: could not load branches, using static fallback:', e.message);
    // Static branch cards from reserve.js remain visible
  }
}

/* ─────────────────────────────────────────────────────────────
   HANDLE API FORM SUBMISSION
───────────────────────────────────────────────────────────────*/
async function handleApiSubmit() {
  // Guard: make sure STATE exists (from reserve.js)
  if (typeof STATE === 'undefined') return;

  // Guard: branch paused
  if (API_BRANCH_PAUSED) {
    showApiError('This branch is not currently accepting online reservations. Please call us directly.');
    return;
  }

  const btn = document.getElementById('confirm-submit');
  if (!btn) return;

  // Button loading state
  setSubmitState(btn, 'loading');

  try {
    // ── Build payload from STATE ─────────────────────────────
    const nameEl  = document.getElementById('res-name');
    const phoneEl = document.getElementById('res-phone');
    const notesEl = document.getElementById('res-notes');

    const payload = {
      branchId:        STATE.branch,
      customerName:    (nameEl?.value  || STATE.name  || '').trim(),
      phone:           (phoneEl?.value || STATE.phone || '').trim(),
      email:           STATE.email || '',
      date:            STATE.date ? formatDateForApi(STATE.date) : '',
      time:            STATE.time  || '',
      guests:          STATE.guests || 2,
      specialRequests: (notesEl?.value || STATE.notes || '').trim(),
      occasion:        STATE.occasionLabel || ''
    };

    // ── Client-side validation ───────────────────────────────
    const validationError = validatePayload(payload);
    if (validationError) {
      setSubmitState(btn, 'idle');
      showApiError(validationError);
      return;
    }

    // ── Call createReservation API ───────────────────────────
    const result = await reserveApiCall('createReservation', payload);

    if (!result.success) {
      setSubmitState(btn, 'idle');
      showApiError(result.error || 'Unable to complete reservation. Please try again.');
      return;
    }

    // ── Success ──────────────────────────────────────────────
    API_BOOKING_REF = result.reservationId || result.bookingRef || '';
    setSubmitState(btn, 'idle');
    showApiSuccess(result);

  } catch (e) {
    setSubmitState(btn, 'idle');
    showApiError('Connection error. Please check your internet and try again, or call us directly.');
    console.error('handleApiSubmit error:', e);
  }
}

/* ─────────────────────────────────────────────────────────────
   VALIDATE PAYLOAD before API call
───────────────────────────────────────────────────────────────*/
function validatePayload(p) {
  if (!p.branchId)                  return 'Please select a branch.';
  if (!p.customerName)              return 'Please enter your name.';
  if (!p.phone || p.phone.replace(/\D/g,'').length < 10)
                                    return 'Please enter a valid 10-digit phone number.';
  if (!p.date)                      return 'Please select a date.';
  if (!p.time)                      return 'Please select a time slot.';
  if (!p.guests || p.guests < 1)    return 'Please select number of guests.';
  if (!p.branchId)                  return 'Please select a branch.';
  return null;
}

/* ─────────────────────────────────────────────────────────────
   FORMAT DATE for API (yyyy-MM-dd)
───────────────────────────────────────────────────────────────*/
function formatDateForApi(dateObj) {
  if (!dateObj) return '';
  try {
    const d = new Date(dateObj);
    return d.getFullYear() + '-' +
           String(d.getMonth() + 1).padStart(2, '0') + '-' +
           String(d.getDate()).padStart(2, '0');
  } catch (e) { return String(dateObj); }
}

/* ─────────────────────────────────────────────────────────────
   SUBMIT BUTTON STATES
───────────────────────────────────────────────────────────────*/
function setSubmitState(btn, state) {
  const textEl    = btn.querySelector('.submit-text');
  const iconEl    = btn.querySelector('.submit-icon');
  const loadingEl = btn.querySelector('.submit-loading');

  if (state === 'loading') {
    btn.disabled = true;
    btn.style.pointerEvents = 'none';
    if (textEl)    textEl.style.display    = 'none';
    if (iconEl)    iconEl.style.display    = 'none';
    if (loadingEl) loadingEl.style.display = 'inline-flex';
  } else {
    btn.disabled = false;
    btn.style.pointerEvents = '';
    if (textEl)    textEl.style.display    = 'inline';
    if (iconEl)    iconEl.style.display    = 'inline';
    if (loadingEl) loadingEl.style.display = 'none';
  }
}

/* ─────────────────────────────────────────────────────────────
   SHOW API SUCCESS — replaces the simulated success screen
───────────────────────────────────────────────────────────────*/
function showApiSuccess(result) {
  // Hide step 4
  const step4 = document.getElementById('step-4');
  if (step4) step4.classList.remove('active');

  // Show success screen
  const successScreen = document.getElementById('success-screen');
  if (!successScreen) return;
  successScreen.classList.add('show');

  // Update booking reference
  const refEl = document.getElementById('booking-ref');
  if (refEl) refEl.textContent = result.reservationId ? 'Booking Ref: ' + result.reservationId : '';

  // Update summary text
  const summaryEl = document.getElementById('success-summary');
  if (summaryEl) {
    summaryEl.innerHTML =
      `<strong style="color:var(--c-gold,#C79A3B);">${result.branch || STATE?.branchName || ''}</strong> branch · ` +
      `<strong>${STATE?.dateLabel || ''}</strong> at <strong>${result.time || STATE?.time || ''}</strong> · ` +
      `${result.guests || STATE?.guests || ''} Guest${(result.guests || STATE?.guests || 1) > 1 ? 's' : ''}` +
      (result.tables ? ` · Tables: ${result.tables}` : '');
  }

  // Update progress to all-done state
  if (typeof STATE !== 'undefined') STATE.step = 5;
  if (typeof updateProgress === 'function') updateProgress();

  // Scroll to top of reservation section
  document.getElementById('reservation-anchor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ─────────────────────────────────────────────────────────────
   SHOW API ERROR — injects error message near submit area
───────────────────────────────────────────────────────────────*/
function showApiError(message) {
  // Remove any existing API error
  document.getElementById('api-error-msg')?.remove();

  const errDiv = document.createElement('div');
  errDiv.id = 'api-error-msg';
  errDiv.style.cssText = `
    background:rgba(140,29,24,.12);
    border:1px solid rgba(140,29,24,.4);
    color:rgba(239,83,80,.9);
    padding:14px 18px;
    font-size:13px;
    line-height:1.7;
    margin-bottom:16px;
    border-radius:4px;
  `;
  errDiv.textContent = '⚠ ' + message;

  const submitRow = document.querySelector('.form-submit-row');
  if (submitRow) submitRow.parentNode.insertBefore(errDiv, submitRow);

  // Auto-remove after 6 seconds
  setTimeout(() => errDiv.remove(), 6000);

  // Scroll error into view
  errDiv.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

/* ─────────────────────────────────────────────────────────────
   5. AVAILABILITY RE-CHECK on Step 2 → Step 3 transition
   Validates the selected slot is still free before moving on
───────────────────────────────────────────────────────────────*/
const _origValidateStep = window.validateStep;
window.validateStep = function (step) {
  // Run original validation first
  const originalResult = typeof _origValidateStep === 'function'
    ? _origValidateStep(step)
    : true;

  if (!originalResult) return false;

  // On step 2, perform a lightweight branch-paused check
  if (step === 1 && API_BRANCH_PAUSED) {
    if (typeof showError === 'function') {
      showError('branch-error', 'This branch is temporarily not accepting online reservations.');
    }
    return false;
  }

  return true;
};

/* ─────────────────────────────────────────────────────────────
   6. GUEST COUNT CHANGE → RE-FETCH SLOTS
   When user changes guest count and a date is already selected
───────────────────────────────────────────────────────────────*/
const _origRenderGuests = window.renderGuests;
window.renderGuests = function (display, noteEl) {
  if (typeof _origRenderGuests === 'function') _origRenderGuests(display, noteEl);

  // If date is selected, re-fetch slots for new guest count
  if (typeof STATE !== 'undefined' && STATE.branch && STATE.date) {
    const dateStr = formatDateForApi(STATE.date);
    // Debounce to avoid too many calls while user taps +/-
    clearTimeout(window._guestFetchTimer);
    window._guestFetchTimer = setTimeout(() => {
      fetchAvailableSlots(STATE.branch, dateStr, STATE.guests || 2);
    }, 600);
  }
};

/* ─────────────────────────────────────────────────────────────
   7. PRE-FILL BRANCH SELECTOR on page load if URL has ?branch=
───────────────────────────────────────────────────────────────*/
(function checkUrlBranch() {
  const params   = new URLSearchParams(window.location.search);
  const branchId = params.get('branch');
  if (!branchId) return;
  // Wait for API branches to load, then auto-select
  const wait = setInterval(() => {
    if (API_BRANCHES.length) {
      clearInterval(wait);
      const match = API_BRANCHES.find(b =>
        b.branchId.toLowerCase() === branchId.toLowerCase() ||
        b.branchName.toLowerCase().includes(branchId.toLowerCase())
      );
      if (match) window.selectBranch(match.branchId);
    }
  }, 300);
  setTimeout(() => clearInterval(wait), 5000); // Stop waiting after 5s
})();

/* ─────────────────────────────────────────────────────────────
   8. NETWORK OFFLINE DETECTION
───────────────────────────────────────────────────────────────*/
window.addEventListener('offline', () => {
  showApiError('You are offline. Please check your internet connection and refresh the page.');
});

/* ─────────────────────────────────────────────────────────────
   WHATSAPP CTA — build message from live STATE
───────────────────────────────────────────────────────────────*/
document.querySelectorAll('#whatsapp-cta').forEach(btn => {
  btn.addEventListener('click', () => {
    if (typeof STATE === 'undefined') return;
    const branch = API_BRANCHES.find(b => b.branchId === STATE.branch);
    const phone  = branch?.phone?.replace(/\D/g,'') || '918912345678';
    const msg = encodeURIComponent(
      `Hi Aha Yemi Ruchulu! I'd like to reserve a table:\n` +
      `Branch: ${STATE.branchName || ''}\n` +
      `Date: ${STATE.dateLabel || ''}\n` +
      `Time: ${STATE.time || ''}\n` +
      `Guests: ${STATE.guests || ''}\n` +
      `Name: ${STATE.name || ''}\n` +
      `Ref: ${API_BOOKING_REF || 'Pending'}`
    );
    window.open(`https://wa.me/${phone}?text=${msg}`, '_blank', 'noopener');
  });
});

/* ─────────────────────────────────────────────────────────────
   DEBUG HELPER — call from browser console to test API
   Usage: testReserveApi()
───────────────────────────────────────────────────────────────*/
window.testReserveApi = async function () {
  console.group('reserve-api.js — API Test');
  console.log('API_URL:', RESERVE_API_URL);
  try {
    const health = await reserveApiCall('health');
    console.log('Health check:', health);
    const branches = await reserveApiCall('getBranches');
    console.log('Branches:', branches);
  } catch (e) {
    console.error('API test failed:', e);
  }
  console.groupEnd();
};