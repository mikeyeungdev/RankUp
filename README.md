# RankUp

RankUp is a portfolio-style League of Legends VOD review platform. It helps players review gameplay clips, annotate timestamps, categorize mistakes, and turn recurring patterns into training goals.

## Demo Scope

- VOD review workspace with timestamped League gameplay annotations
- Mistake categories for macro, positioning, objective control, and mechanics
- Dashboard-style analytics for improvement trends and training goals
- Mock OpenAI review generation flow for summaries and actionable recommendations
- PostgreSQL schema included for a production version of the app

## Open The Demo

Open `index.html` in a browser. No build step is required.

## Suggested Full-Stack Upgrade

The static demo is intentionally easy to present. A production version could use:

- Next.js and TypeScript for the web app
- PostgreSQL for users, VODs, annotations, mistake tags, goals, and AI reports
- Prisma for database access
- OpenAI API for generated summaries and training recommendations
- Object storage such as S3 or Supabase Storage for uploaded gameplay clips

## OpenAI Workflow

1. Player uploads or links a VOD.
2. Player adds timestamped notes and mistake tags.
3. Backend sends structured review data to an OpenAI model.
4. Model returns a summary, repeated mistake patterns, and weekly training goals.
5. The app stores the generated report and displays it in the dashboard.

Example prompt shape:

```text
You are a League of Legends VOD review coach.
Analyze these timestamp notes by category.
Return:
- concise summary
- top recurring mistakes
- objective-control advice
- three concrete training goals
```

## Project Pitch

RankUp demonstrates full-stack product thinking: data modeling, interactive UI, user-centered analytics, and AI-assisted feedback workflows. The project is scoped for a strong CS portfolio demo while leaving a clear path toward a real PostgreSQL-backed application.
