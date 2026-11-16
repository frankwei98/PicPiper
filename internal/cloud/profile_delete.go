package cloud

import "os"

// Delete a local connection only. Upload records are bucket-scoped and may
// still belong to another profile pointing at that bucket.
func (s *Service) deleteProfile(id string) (settings, error) {
	if !validID(id) {
		return settings{}, appErr("invalidProfileId", "Choose a valid storage profile.")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.loadSettingsLocked()
	if err != nil {
		return settings{}, err
	}
	next := current
	next.Profiles = make([]profile, 0, len(current.Profiles))
	found := false
	for _, p := range current.Profiles {
		if p.ID == id {
			found = true
		} else {
			next.Profiles = append(next.Profiles, p)
		}
	}
	if !found {
		return settings{}, appErr("profileMissing", "This storage profile no longer exists. Reload Settings.")
	}
	if next.DefaultProfileID != nil && *next.DefaultProfileID == id {
		next.DefaultProfileID = nil
	}
	if current.Mini != nil && current.Mini.ProfileID == id {
		mini := *current.Mini
		mini.ProfileID = ""
		next.Mini = &mini
	}
	if err = validateSettings(next); err != nil {
		return settings{}, err
	}
	// Persist references first so a failed settings write cannot destroy a
	// still-configured credential. A cleanup failure restores the old settings.
	if err = s.saveSettingsLocked(next); err != nil {
		return settings{}, err
	}
	if err = os.Remove(s.secretPath(id)); err != nil && !os.IsNotExist(err) {
		if restoreErr := s.saveSettingsLocked(current); restoreErr != nil {
			return settings{}, appErr("profileDeleteIncomplete", "Could not remove the saved credential or restore the profile. Reload Settings before retrying.")
		}
		return settings{}, appErr("credentialDeleteFailed", "Could not remove the saved credential. The profile was kept; check local file permissions and retry.")
	}
	return next, nil
}
