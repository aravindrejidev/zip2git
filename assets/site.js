/* Zip2Git — shared across every page: mobile nav, accordions, footer year. */
(function(){
  'use strict';

  const navToggle = document.getElementById('navToggle');
  const mobileMenu = document.getElementById('mobileMenu');

  if(navToggle && mobileMenu){
    navToggle.addEventListener('click', () => {
      const open = mobileMenu.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', String(open));
    });
    mobileMenu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => {
      mobileMenu.classList.remove('open');
      navToggle.setAttribute('aria-expanded', 'false');
    }));
  }

  document.querySelectorAll('.accordion-trigger').forEach((trigger) => {
    trigger.addEventListener('click', () => {
      trigger.closest('.accordion-item').classList.toggle('open');
    });
  });

  const yearEl = document.getElementById('yearNow');
  if(yearEl) yearEl.textContent = new Date().getFullYear();
})();
