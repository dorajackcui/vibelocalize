on run argv
	set bundleId to item 1 of argv
	set processName to item 2 of argv
	set startCell to item 3 of argv
	set rowCount to (item 4 of argv) as integer
	set settleDelay to (item 5 of argv) as number

	tell application id bundleId to activate
	delay 0.35

	tell application "System Events"
		tell process processName
			key code 53
			delay 0.1
			key code 123
			delay 0.1
			key code 5 using {command down}
			delay 0.2
			keystroke startCell
			key code 36
			delay 0.2
			if rowCount > 1 then
				repeat (rowCount - 1) times
					key code 125 using {shift down}
				end repeat
				delay 0.1
			end if
			keystroke "c" using {command down}
		end tell
	end tell

	delay settleDelay
end run
