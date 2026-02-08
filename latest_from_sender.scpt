on run argv
	if (count of argv) = 0 then return "ERROR: missing sender query"
	set q to item 1 of argv
	
	tell application "Mail"
		set msgs to messages of inbox
		if q is "" then
			-- Return the latest email (first in list)
			if (count of msgs) > 0 then
				set m to item 1 of msgs
				return "FROM: " & (sender of m) & "\nSUBJECT: " & (subject of m) & "\nBODY:\n" & (content of m)
			end if
		else
			-- Search for specific sender
			repeat with i from 1 to (count of msgs)
				set m to item i of msgs
				set f to sender of m
				if f contains q then
					return "FROM: " & f & "\nSUBJECT: " & (subject of m) & "\nBODY:\n" & (content of m)
				end if
			end repeat
		end if
	end tell
	
	return "NOT_FOUND"
end run
