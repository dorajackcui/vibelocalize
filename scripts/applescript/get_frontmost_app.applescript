on run
	tell application "System Events"
		set frontApp to first application process whose frontmost is true
		return (name of frontApp) & "|" & (bundle identifier of frontApp)
	end tell
end run
