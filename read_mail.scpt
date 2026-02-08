tell application "Mail"
	set inboxMessages to messages of inbox
	if (count of inboxMessages) = 0 then
		return "No mail"
	end if

	set m to item 1 of inboxMessages
	set s to subject of m
	set f to sender of m
	set c to content of m

	return "FROM: " & f & "\nSUBJECT: " & s & "\nBODY:\n" & c
end tell
