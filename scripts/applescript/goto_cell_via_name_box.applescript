on run argv
	set bundleId to item 1 of argv
	set processName to item 2 of argv
	set targetCell to item 3 of argv

	tell application id bundleId to activate
	delay 0.35

	tell application "System Events"
		tell process processName
			key code 53
			delay 0.1
			repeat 4 times
				key code 97
				delay 0.08
			end repeat
			keystroke targetCell
			key code 36
			delay 0.2
		end tell
	end tell
end run
