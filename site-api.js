/**
 * Shared Google Apps Script Web App bridge for public site forms.
 * Deploy ggggsssss/*.gs in Apps Script, then paste the Web App URL below.
 */
const AYR_API = {
  URL: 'https://script.google.com/macros/s/AKfycbxCvG16NhAtmHc33FX5hwNgan7szrROlvOKqjvpq85kUHY5Xpu3opqYFGN2Ju5mUgdl/exec',
  TIMEOUT_MS: 20000,

  async call(action, data = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.TIMEOUT_MS);
    try {
      const response = await fetch(this.URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, ...data }),
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!response.ok) {
        throw new Error('Network error: ' + response.status);
      }
      const text = await response.text();
      try {
        return JSON.parse(text);
      } catch (parseErr) {
        throw new Error('Invalid response from server');
      }
    } catch (error) {
      const msg = error.name === 'AbortError'
        ? 'Request timed out. Please try again.'
        : (error.message || 'Connection failed');
      console.error('[AYR API]', action, msg);
      return { success: false, error: msg };
    } finally {
      clearTimeout(timer);
    }
  },
};

/** @deprecated Use AYR_API — kept for older snippets */
const RESERVE_API = {
  URL: AYR_API.URL,
  async request(action, data = {}) {
    return AYR_API.call(action, data);
  },
  async getBranches() {
    return AYR_API.call('getBranches');
  },
  async getAvailableSlots(branchId, date, guests) {
    return AYR_API.call('getAvailableSlots', { branchId, date, guests: parseInt(guests, 10) });
  },
  async submitBooking(bookingData) {
    return AYR_API.call('createReservation', bookingData);
  },
};
