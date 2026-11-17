package cloud

// A settings form owns either storage fields or general preferences. Merge
// those edits with the latest disk value so profile writes and rollback never
// restore an old Mini snapshot from another window.
func (s *Service) saveScopedSettings(draft settings, scope string, miniBase *MiniSettings) (settings, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, err := s.loadSettingsLocked()
	if err != nil {
		return settings{}, err
	}
	switch scope {
	case "storage":
		current.Profiles = draft.Profiles
		current.NamingTemplate = draft.NamingTemplate
		current.DefaultProfileID = draft.DefaultProfileID
	case "general":
		if miniBase == nil || draft.Mini == nil {
			return settings{}, appErr("invalidRequest", "General preference edits require their original Mini settings.")
		}
		mini := clipboardMiniSettings(current.Mini)
		if draft.Mini.Enabled != miniBase.Enabled {
			mini.Enabled = draft.Mini.Enabled
		}
		if draft.Mini.TargetFormat != miniBase.TargetFormat {
			mini.TargetFormat = draft.Mini.TargetFormat
		}
		if draft.Mini.Quality != miniBase.Quality {
			mini.Quality = draft.Mini.Quality
		}
		current.Mini = mini
		current.CloseBehavior = normalizedCloseBehavior(draft.CloseBehavior)
		current.ProcessingConcurrency = draft.ProcessingConcurrency
	default:
		return settings{}, appErr("invalidRequest", "Choose a supported settings scope.")
	}
	if err = validateSettings(current); err != nil {
		return settings{}, err
	}
	if err = s.saveSettingsLocked(current); err != nil {
		return settings{}, err
	}
	return current, nil
}
