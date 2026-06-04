// Mobile nav
const toggle = document.querySelector('.nav-toggle');
const nav = document.getElementById('primary-nav');
if (toggle && nav) {
  toggle.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  nav.querySelectorAll('a').forEach(function (a) {
    a.addEventListener('click', function () {
      nav.classList.remove('open');
      toggle.setAttribute('aria-expanded', 'false');
    });
  });
}

// Booking form submission
var form = document.getElementById('booking-form');
var success = document.getElementById('booking-success');
var errorBox = document.getElementById('booking-error');
var submitBtn = form ? form.querySelector('button[type="submit"]') : null;

if (form) {
  form.addEventListener('submit', function (e) {
    e.preventDefault();

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    if (errorBox) errorBox.hidden = true;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.dataset.originalText = submitBtn.dataset.originalText || submitBtn.textContent;
      submitBtn.textContent = 'Sending\u2026';
    }

    var formData = new FormData(form);
    var firstName = (formData.get('first_name') || '').trim();
    var lastName = (formData.get('last_name') || '').trim();
    var fullName = (firstName + ' ' + lastName).trim();
    var services = formData.getAll('service').join(', ');
    var subject = 'New booking' + (fullName ? ' \u2014 ' + fullName : '') + (services ? ' (' + services + ')' : '');
    formData.append('subject', subject);
    var email = formData.get('email');
    if (email) formData.append('replyto', email);

    fetch(form.action, {
      method: 'POST',
      body: formData
    })
      .then(function (res) {
        return res.json().then(function (payload) {
          if (!res.ok || (payload && payload.success === false)) {
            var msg = (payload && payload.message)
              || (payload && payload.errors && payload.errors[0] && payload.errors[0].message);
            throw new Error(msg || 'Could not submit your request.');
          }
          form.hidden = true;
          success.hidden = false;
          success.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      })
      .catch(function (err) {
        if (errorBox) {
          errorBox.textContent = (err && err.message)
            ? err.message
            : 'Could not submit. Please try again or call 0402 654 148.';
          errorBox.hidden = false;
          errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = submitBtn.dataset.originalText || 'Submit Booking Request';
        }
        // Turnstile tokens are single-use — reset the widget so the user can retry.
        if (window.turnstile && typeof window.turnstile.reset === 'function') {
          window.turnstile.reset();
        }
      });
  });
}
