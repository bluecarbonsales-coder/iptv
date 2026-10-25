(function () {
  'use strict';
  const footer = document.querySelector('.foot');
  if (!footer) return;

  // Keep this optional feature out of the way until a visitor explicitly opens it.
  const section = document.createElement('section');
  section.className = 'visitor-discovery';
  section.style.cssText = 'max-width:1600px;margin:18px auto 26px;padding:0 clamp(16px,3.2vw,52px);color:#d8d9df';

  const details = document.createElement('details');
  details.style.cssText = 'border:1px solid #292d39;border-radius:12px;background:#0e1017;overflow:hidden';

  const summary = document.createElement('summary');
  summary.style.cssText = 'display:flex;align-items:center;gap:12px;min-height:48px;padding:12px 15px;cursor:pointer;list-style:none;user-select:none';
  const title = document.createElement('span');
  title.textContent = 'Improve local resource discovery';
  title.style.cssText = 'font-size:13px;font-weight:650;color:#dfe0e7';
  const optional = document.createElement('span');
  optional.textContent = 'OPTIONAL';
  optional.style.cssText = 'font-size:9px;letter-spacing:.1em;font-weight:750;padding:3px 6px;border-radius:5px;background:#20232d;color:#a8adbb';
  const summaryHint = document.createElement('span');
  summaryHint.textContent = 'Help prioritize official and open-license resources for your broad region';
  summaryHint.style.cssText = 'font-size:11px;color:#858a9a;flex:1;min-width:0';
  const chevron = document.createElement('span');
  chevron.textContent = '⌄';
  chevron.setAttribute('aria-hidden', 'true');
  chevron.style.cssText = 'font-size:16px;color:#aeb2bf;transition:transform .15s';
  summary.append(title, optional, summaryHint, chevron);
  details.addEventListener('toggle', () => {
    chevron.style.transform = details.open ? 'rotate(180deg)' : '';
    summary.setAttribute('aria-expanded', String(details.open));
  });
  summary.setAttribute('aria-expanded', 'false');

  const body = document.createElement('div');
  body.style.cssText = 'padding:0 15px 16px;border-top:1px solid #232632';
  const description = document.createElement('p');
  description.textContent = 'Share only a country code, an optional broad region, language and resource interest. Nothing is sent unless you consent. Do not enter your address or precise coordinates.';
  description.style.cssText = 'max-width:900px;margin:13px 0;color:#969bab;font-size:12px;line-height:1.55';

  const form = document.createElement('form');
  form.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px;align-items:end';

  function field(labelText, control) {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;flex-direction:column;gap:5px;font-size:11px;color:#b7bac6';
    wrapper.append(document.createTextNode(labelText), control);
    control.style.cssText = 'width:100%;padding:9px 10px;background:#080a10;border:1px solid #303442;border-radius:8px;color:#f5f5f7;min-width:0;font:inherit;font-size:12px';
    return wrapper;
  }

  const country = document.createElement('input');
  country.placeholder = 'e.g. JP';
  country.maxLength = 2;
  country.autocomplete = 'off';
  country.required = true;
  country.pattern = '[A-Za-z]{2}';
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
    const option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    category.append(option);
  }

  const consentLabel = document.createElement('label');
  consentLabel.style.cssText = 'display:flex;gap:8px;align-items:flex-start;grid-column:1/-1;font-size:11px;color:#9da1af;line-height:1.5';
  const consent = document.createElement('input');
  consent.type = 'checkbox';
  consent.required = true;
  consent.style.cssText = 'margin:2px 0 0;accent-color:#e8c78b;flex-shrink:0';
  const consentText = document.createElement('span');
  consentText.textContent = 'I consent to sharing these broad preferences for aggregate resource discovery. Daily totals are retained for up to 30 days, and groups with fewer than three requests are suppressed.';
  consentLabel.append(consent, consentText);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;align-items:center;gap:12px;flex-wrap:wrap;grid-column:1/-1';
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.textContent = 'Share preferences';
  submit.style.cssText = 'padding:9px 13px;border-radius:8px;border:1px solid #e8c78b;background:#e8c78b;color:#18140c;font-size:12px;font-weight:700;cursor:pointer';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.style.cssText = 'margin:0;color:#aeb2c0;font-size:11px;line-height:1.5';
  actions.append(submit, status);

  form.append(
    field('Country code (required)', country),
    field('Broad region (optional)', region),
    field('Language', language),
    field('Resource interest', category),
    consentLabel,
    actions
  );
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!consent.checked) return;
    submit.disabled = true;
    status.textContent = 'Sending opted-in preferences…';
    try {
      const response = await fetch('/api/visitor/context', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          consent: true,
          country: country.value.trim(),
          region: region.value.trim(),
          language: language.value.trim(),
          category: category.value
        })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Request failed');
      status.textContent = 'Thanks — only aggregate counts were stored.';
      consent.checked = false;
    } catch (error) {
      status.textContent = error.message || 'Could not save preferences.';
    } finally {
      submit.disabled = false;
    }
  });

  body.append(description, form);
  details.append(summary, body);
  section.append(details);
  footer.parentNode.insertBefore(section, footer);
})();
