(function () {
  'use strict';
  const footer = document.querySelector('.foot');
  if (!footer) return;
  const section = document.createElement('section');
  section.setAttribute('aria-labelledby', 'visitorDiscoveryTitle');
  section.style.cssText = 'margin:24px 0;padding:16px;border:1px solid #343746;border-radius:14px;background:#11131b;color:#d8d9df';
  const title = document.createElement('h3');
  title.id = 'visitorDiscoveryTitle';
  title.textContent = 'Improve local resource discovery (optional)';
  title.style.marginTop = '0';
  const description = document.createElement('p');
  description.textContent = 'Share a broad area, language and interest so Hermes can prioritize relevant official and open-license resources. Nothing is sent unless you opt in. Do not enter your address or precise coordinates.';
  description.style.color = '#aeb2c0';
  const form = document.createElement('form');
  form.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;align-items:end';
  function field(labelText, control) {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:5px;font-size:12px';
    wrapper.append(document.createTextNode(labelText), control);
    control.style.cssText = 'padding:9px;background:#090b11;border:1px solid #343746;border-radius:8px;color:#fff;min-width:0';
    return wrapper;
  }
  const country = document.createElement('input');
  country.placeholder = 'e.g. JP';
  country.maxLength = 2;
  country.autocomplete = 'off';
  country.setAttribute('aria-label', 'Country code');
  const region = document.createElement('input');
  region.placeholder = 'e.g. Tokyo (optional)';
  region.maxLength = 40;
  region.autocomplete = 'off';
  region.setAttribute('aria-label', 'Broad region');
  const language = document.createElement('input');
  language.value = (navigator.language || 'en').split('-')[0].toLowerCase();
  language.maxLength = 16;
  language.setAttribute('aria-label', 'Preferred language');
  const category = document.createElement('select');
  for (const [value, label] of [['live-tv','Live TV'],['movies','Movies'],['series','TV series'],['anime','Anime'],['documentary','Documentaries'],['radio','Radio'],['local-news','Local news'],['culture','Local culture'],['sports','Sports'],['education','Education'],['other','Other']]) {
    const option = document.createElement('option'); option.value = value; option.textContent = label; category.append(option);
  }
  const consentLabel = document.createElement('label');
  consentLabel.style.cssText = 'display:flex;gap:8px;align-items:flex-start;grid-column:1/-1;font-size:12px';
  const consent = document.createElement('input'); consent.type = 'checkbox'; consent.required = true;
  const consentText = document.createElement('span');
  consentText.textContent = 'I consent to sending these broad preferences for aggregate resource discovery. The server stores daily totals only, retains them for up to 30 days, and suppresses groups with fewer than three requests.';
  consentLabel.append(consent, consentText);
  const submit = document.createElement('button');
  submit.type = 'submit'; submit.textContent = 'Share preferences';
  submit.style.cssText = 'padding:10px 13px;border-radius:9px;border:1px solid #e8c78b;background:#e8c78b;color:#18140c;font-weight:700;cursor:pointer';
  const status = document.createElement('p');
  status.setAttribute('role', 'status'); status.style.cssText = 'grid-column:1/-1;margin:0;color:#aeb2c0;font-size:12px';
  form.append(field('Country code (required)', country), field('Broad region (optional)', region), field('Language', language), field('Resource interest', category), consentLabel, submit, status);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!consent.checked) return;
    submit.disabled = true; status.textContent = 'Sending opted-in preferences…';
    try {
      const response = await fetch('/api/visitor/context', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ consent: true, country: country.value, region: region.value, language: language.value, category: category.value })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Request failed');
      status.textContent = 'Thank you. Only aggregate counts were stored; no precise location or account identity was sent by this form.';
      form.reset(); language.value = (navigator.language || 'en').split('-')[0].toLowerCase();
    } catch (error) { status.textContent = error.message; }
    finally { submit.disabled = false; }
  });
  section.append(title, description, form);
  footer.parentNode.insertBefore(section, footer);
})();