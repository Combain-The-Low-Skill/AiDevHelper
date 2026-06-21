# AiDevHelper

This program can do things you want in the directory you want — just by asking it.

It scans the project files in a folder you choose, sends them along with your request to an AI model, and writes the changes straight back to disk.

## Getting Started

1. Clone or download this repository.
2. Open a console in the installed directory and run:
   ```bash
   npm install
   ```
   This downloads all required node modules.
3. Create your own `.env` file right in the directory and add:
   ```
   GROQ_API_KEY=<your_groq_api_key>
   ```
   (without the brackets, of course)
4. Start the program:
   ```bash
   npm start
   ```
   Then open `index.html` in your browser.

> **Note:** Dont forget that for proper working you need to install Node with version 18.x.x+ .Also you might have to use a VPN if you are accessing this from a country where Groq/Google APIs are restricted (e.g. Russia).

## Notes

- Never commit your `.env` file anywhere — it contains your private API key.
- Point the program at a separate test/working directory rather than its own folder, to avoid it overwriting its own source files while running.