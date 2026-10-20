import React, { useEffect, useState } from 'react';
import { getAppearance, setAppearance, type Appearance } from './appearance';
import Markdown from './Markdown';

export default function AppearanceSettings() {
  const [appearance, update] = useState(getAppearance);
  useEffect(() => {
    const changed = () => update(getAppearance());
    window.addEventListener('guildmaster:appearance-changed', changed);
    return () => window.removeEventListener('guildmaster:appearance-changed', changed);
  }, []);
  const change = (patch: Partial<Appearance>) => setAppearance({ ...appearance, ...patch });
  return <div className="appearance-settings">
    <section className="settings-section">
      <div className="settings-section-title"><div><h2>Theme</h2><p>Choose a theme or follow your system appearance.</p></div></div>
      <fieldset className="theme-options"><legend className="sr-only">Theme</legend>{(['system', 'light', 'dark', 'guildhall'] as const).map(theme => <label className={`theme-option ${appearance.theme === theme ? 'selected' : ''}`} key={theme}>
        <span className={`theme-preview ${theme === 'system' ? 'theme-preview-system' : ''}`} aria-hidden="true">{(theme === 'system' ? ['light', 'dark'] : [theme]).map(tone => <span className="theme-mini" data-tone={tone} key={tone}><span className="theme-mini-sidebar"/><span className="theme-mini-lines"><i/><i/><i/></span></span>)}</span>
        <span className="theme-option-label"><input type="radio" name="theme" value={theme} checked={appearance.theme === theme} onChange={() => change({ theme })}/>{{ system: 'System', light: 'Light', dark: 'Dark', guildhall: 'Guildhall' }[theme]}</span>
      </label>)}</fieldset>
    </section>
    <section className="settings-section">
      <div className="settings-section-title"><div><h2>Conversation text</h2><p>Adjust reading size in Guildmaster, quest, and agent conversations.</p></div></div>
      <label className="field appearance-size">Text size<select aria-label="Text size" value={appearance.textSize} onChange={event => change({ textSize: event.target.value as Appearance['textSize'] })}><option value="default">Standard</option><option value="large">Large</option><option value="larger">Extra large</option></select></label>
      <div className="appearance-preview transcript"><span className="appearance-preview-label">Preview</span><Markdown text={'### A clear view of your work\nThe update is ready for review. The checks pass, and the changes are in `src/app.ts`.'}/></div>
    </section>
    <section className="settings-section">
      <div className="settings-section-title"><div><h2>Motion</h2><p>Reduce interface animations. Your system’s reduced motion preference is always respected.</p></div></div>
      <label className="field appearance-size">Animation preference<select aria-label="Animation preference" value={appearance.motion} onChange={event => change({ motion: event.target.value as Appearance['motion'] })}><option value="system">Follow system</option><option value="reduced">Reduce motion</option></select></label>
    </section>
    <p className="appearance-note">Changes apply immediately and are saved in this browser.</p>
  </div>;
}
