package cloud

type CloseBehavior string

const (
	CloseQuit       CloseBehavior = "quit"
	CloseBackground CloseBehavior = "background"
)

func normalizedCloseBehavior(value CloseBehavior) CloseBehavior {
	if value == CloseBackground {
		return CloseBackground
	}
	return CloseQuit
}

type DesktopPreferences struct {
	StatusIconEnabled bool
	CloseBehavior     CloseBehavior
}

// DesktopPreferences loads the native lifecycle preferences in one snapshot.
// CloseBehavior is the user's choice; a live status icon overrides it without
// overwriting the preference, so disabling the icon restores that choice.
func (s *Service) DesktopPreferences() (DesktopPreferences, error) {
	v, err := s.loadSettings()
	if err != nil {
		return DesktopPreferences{}, err
	}
	return DesktopPreferences{StatusIconEnabled: v.Mini.Enabled, CloseBehavior: v.CloseBehavior}, nil
}
