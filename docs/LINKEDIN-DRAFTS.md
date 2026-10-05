# LinkedIn drafts awaiting the Ledger (2026-10-05)

Four rental-business drafts Shane picked on 2026-10-05. Not yet in the Lab Intelligence Ledger (https://claude.ai/artifact/Ai5xKScgT2sWtqXRQ1ZA8i). Delete this file once they are.

Queue order to append after post 95: 97, 96, 98, 99 (Impact, MarTech, AI, MarTech), so no two neighbours share a pillar.

---

## Post 96 · MarTech · project `rental`

Source: `{"cmo": {"url": "https://claude.ai/artifact/GSG4tVzFVzbgD4m5eacsrB"}, "tech": {"url": "https://github.com/shanelabountyai/rental-business/blob/main/WRITEUP.md#defects-found", "section": "Defects Found"}}`

My texts honoured STOP. They didn't honour "please stop texting me."

That's in a sample rental platform I built on synthetic data. It texts tenants about rent and repairs, and the opt-out did what most do: it looked for a keyword. Send STOP on its own and you were out.

A person who is fed up doesn't send a keyword. They send a sentence. "Stop texting me." "Do not contact me again." Each of those landed in the message thread as an ordinary reply, and the texts kept coming.

A legal review I ran after the build was finished caught it, along with the reverse problem. YES was on the list of words that opt you back in. A tenant who had opted out and later replied "Yes" was subscribed again without being asked.

The fix had a trap in it. Match any message containing "stop" and "please stop the leak" opts a tenant out of the texts about their own repair. So a keyword still has to be the whole message, and a sentence only counts if it's on a short list that names texting or contact. Only START and UNSTOP opt you back in now.

I led the team running one of the five largest Marketo instances at the time. There, unsubscribe was a link, and a link can't be misread. A reply can.

How does your opt-out handle someone who answers in their own words?

#martech #marketingoperations #consent #sms

---

## Post 97 · Impact · project `rental`

Source: `{"cmo": {"url": "https://claude.ai/artifact/GSG4tVzFVzbgD4m5eacsrB"}, "tech": {"url": "https://github.com/shanelabountyai/rental-business/blob/main/WRITEUP.md#defects-found", "section": "Defects Found"}}`

A tenant paid $1,000 in rent and a $30 card fee. My ledger credited them $1,030.

This is a sample rental platform I built on synthetic data. Paying rent by card carries a pass-through fee, disclosed up front. The card processor collects one amount, $1,030, and that was the number that came back to the books.

So the books took $1,030 off what the tenant owed. The fee was never a debt on their account. It's the price of using the card. Every card payment left the tenant looking $30 further ahead than they were, and the automated test for that payment agreed. It had been written to expect $1,030.

Nothing crashed and no total looked strange. A review focused only on money found it, after the build was finished, by asking one thing of every payment path: which number is this?

The fix was to stop treating one transaction as one number. The processor collected $1,030, and the receipt shows it. The tenant's balance went down by $1,000.

I ran tracking and reporting for a marketing budget of more than $100M, and this is the argument I had there too. Paid, committed and owed are different numbers that share a column until someone separates them.

Where in your reporting is one figure doing the work of two?

#dataquality #reporting #marketingoperations #accountability

---

## Post 98 · AI · project `rental`

Source: `{"cmo": {"url": "https://claude.ai/artifact/GSG4tVzFVzbgD4m5eacsrB"}, "tech": {"url": "https://github.com/shanelabountyai/rental-business/blob/main/WRITEUP.md#defects-found", "section": "Defects Found"}}`

I called my rental platform feature-complete. Then seven reviewers found 41 more things.

It's a sample build on synthetic data with thousands of automated tests behind it. I'd already had it reviewed five times by an AI agent briefed as a long-time owner-operator.

This time I split the review. Seven AI reviewers, each given one concern and nothing else: security, money, legal exposure, day-to-day operations, cost, accessibility, design.

What came back was different in kind. Autopay payments credited twice. A card fee counted as rent paid. A text opt-out that only worked if you sent the exact keyword.

A reviewer asked to check everything checks what it already knows to look for, and that's mostly what I knew to build. Brief one on money alone and it reads every payment path the way an accountant would.

I ran creative operations at more than 1,000 projects a year, and I'd say the same of people. One combined sign-off gets you the average of everyone's attention.

39 of the 41 are fixed. I left two open on purpose. One is whether a late-fee grace period should be one day or two under Texas law. That's an attorney's answer, not mine. The CPMAI question, "what is the human actually judging here?", was easy for that one.

How do you split a review when no single reader can hold every concern?

#aiassisteddevelopment #cpmai #qualityassurance #marketingoperations

---

## Post 99 · MarTech · project `rental`

Source: `{"cmo": {"url": "https://claude.ai/artifact/GSG4tVzFVzbgD4m5eacsrB"}, "tech": {"url": "https://github.com/shanelabountyai/rental-business/blob/main/WRITEUP.md"}}`

The dashboard tile said "Aged delinquency." The owner calls it "rent overdue."

That's the home screen of a sample rental platform I built on synthetic data. Every number on it was right. I'd named the tiles the way the code names things.

"Aged delinquency." "Tenancies past grace." A tile for urgent tickets with a second line reading "Open past 48h." The menu had a page called "Gone dark" with nothing to say what it was.

An owner with twenty houses doesn't think in those words. They think: who's late, and what's been broken for too long.

So the last piece of work on the build changed no logic at all. "Aged delinquency" became "Rent overdue." "Tenancies past grace" became "Late tenants." The two urgent-ticket lines became one: "Urgent repairs waiting over 2 days." The three menu items nobody could guess got a plain line underneath.

I've shipped marketing performance dashboards to executives who had no part in building them. The ones that went unopened usually had correct data. The labels were written by the people who built the pipeline, for the people who built the pipeline.

A number someone has to translate before they can act on it is one they'll stop checking.

Which label on your dashboard only makes sense to the team that built it?

#martech #reporting #dashboards #productdesign
