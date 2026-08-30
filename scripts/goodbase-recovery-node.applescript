on run
	try
		«event sysoexec» "/bin/bash /Users/maurice/.local/bin/goodbase-recovery-node.sh >> /Users/maurice/Library/Logs/Goodbase/recovery-verify.log 2>&1"
	on error
		«event sysonotf» "Recovery verification failed. Details were saved to the Goodbase recovery log." given «class appr»:"Goodbase Recovery"
	end try
end run
