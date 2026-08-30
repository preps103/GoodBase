on run
	try
		«event sysoexec» "/bin/zsh /Users/maurice/.local/bin/goodos-backup-pull.sh"
	on error
		«event sysonotf» "The off-site backup copy could not reach the server. It will retry automatically." given «class appr»:"Goodbase Recovery"
	end try
end run
