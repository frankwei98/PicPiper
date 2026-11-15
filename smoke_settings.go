package main

import (
	"time"

	"github.com/egoist/mygo"
)

func smokeSettingsPreferencesFit(win *mygo.Window) error {
	return smokeWait(win, `(() => {
const panel = document.getElementById('settings-section-general');
if (!panel || panel.hidden) return false;
const rows = [...panel.querySelectorAll('.preference-row')].filter(row => row.getBoundingClientRect().height > 0);
if (rows.length !== 10) return false;
const viewport = panel.closest('.workspace-scroll'), content = panel.closest('.settings-content');
const expectedRight = viewport.getBoundingClientRect().left + viewport.clientWidth - parseFloat(getComputedStyle(content).paddingRight);
return rows.every(row => {
  const copy = row.querySelector('.preference-copy'), control = row.querySelector('.preference-control');
  const left = copy.getBoundingClientRect(), right = control.getBoundingClientRect();
  const title = row.querySelector('.preference-label'), description = row.querySelector('.preference-description');
  const rowStyle = getComputedStyle(row);
  return Math.abs(right.right - expectedRight) < 1
    && [...control.querySelectorAll('select,input:not([type="checkbox"]),[data-slot="switch"]')].every(input => Math.abs(input.getBoundingClientRect().right - expectedRight) < 1)
    && right.left >= left.right + 10 && Math.abs((right.top + right.bottom - left.top - left.bottom) / 2) < 1
    && rowStyle.paddingTop === '20px' && rowStyle.paddingBottom === '20px' && rowStyle.borderBottomWidth === '1px'
    && getComputedStyle(title).fontSize === '14px'
    && getComputedStyle(title).color === getComputedStyle(panel.querySelector('.settings-title')).color
    && (!description || getComputedStyle(description).fontSize === '12px')
    && [...control.querySelectorAll('select,input:not([type="checkbox"])')].every(input => Math.abs(input.getBoundingClientRect().height - 36) < 1);
}) && Math.abs(panel.querySelector('.settings-actions button').getBoundingClientRect().right - expectedRight) < 1
  && document.scrollingElement.scrollWidth <= innerWidth + 1;
})()`, 5*time.Second)
}
