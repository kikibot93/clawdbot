on run argv
	if (count of argv) < 2 then return "ERROR: need recipient and message"
	set recipient to item 1 of argv
	set message to item 2 of argv
	
	tell application "Mail"
		set newMessage to make new outgoing message with properties {visible:false}
		tell newMessage
			make new to recipient at end of to recipients with properties {address:recipient as string}
			set content to message as string
			send
		end tell
	end tell
	
	return "SENT"
end run
