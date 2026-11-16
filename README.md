# Feud: a local Family Feud game

A Family Feud-style game for parties and community events. It runs entirely in your browser. You don't need internet, an account or an install.

- **Host Console** (`index.html`) runs on your laptop screen. You see every answer and every control.
- **Audience Display** (`display.html`) goes on the projector or TV and shows only the board, scores, strikes and animations.

---

## 1. Start it

Pick one:

| Computer | How |
|---|---|
| **Windows** | Double-click `start-windows.bat` |
| **Mac** | Double-click `start-mac.command`. The first time, right-click it, choose **Open**, then **Open** again. |
| **Linux** | Run `./start-linux.sh` |
| **Any** | Double-click `index.html`. This works without a server in Chrome, Edge or Firefox. |

The launchers start a tiny local server at **http://localhost:8080** using Python or Node.js, whichever you have. Nothing leaves your computer. If you have neither, open `index.html` directly.

Chrome or Edge is recommended.

## 2. Set up the screens

1. In the Host Console, click **Open Display ↗** (or press **D**). If nothing opens, allow pop-ups for the page.
2. Drag the new window onto the projector or TV.
3. **Click once inside it.** Browsers won't play sound until you do. Then press **F** or double-click for fullscreen.
4. The top bar of the host shows **Display connected**.

**Only one screen, or a mirrored screen?** Open **Questions → Print answer sheets**, keep the display fullscreen and run the game from the keyboard. Keys pressed on the display window control the game too.

## 3. Play a round

The panel on the right always shows the next step. It follows the TV rules:

1. **Face-off.** Click the answer each player gives, or press **X** for a wrong one. Then click **Team 1 won** or **Team 2 won**.
2. **Play or Pass.** Choose what the winning team decides.
3. **Play the board.** Click correct answers and press **X** for strikes. At 3 strikes the other team gets to steal.
4. **Steal.** Click their answer if it's on the board and they win the bank. Otherwise press **Steal failed** and the playing team keeps it.
5. The bank goes to the right team automatically. Press **Next round**.

- Click any answer, in any order, to reveal it.
- An answer only ever scores once.
- **Shift-click** an answer, or hold Shift with its number key, to reveal it without points.
- **Reveal all** shows every remaining answer without scoring.

## 4. Fixing mistakes

- **Undo** (Ctrl/Cmd+Z) works on every game action, as many times as you like. Redo is Ctrl/Cmd+Shift+Z. Undo still works after a browser refresh.
- **Host overrides & corrections** (right column) let you change control, phase, strikes and the bank, and the round number. You can also:
  - award the bank to either team. Awarding again *moves* the points.
  - end a round with no award, or restart a round.
  - turn on sudden death.
- Team scores have quick **±** buttons plus **Add / Sub / Set**. Team names are edited in place.
- Each answer on the host board has a **hide** link that puts it back.

## 5. Questions

Click **Questions** to:

- add, edit, duplicate, reorder and delete questions, with up to 10 answers each
- set a multiplier per question (for example, always double)
- jump straight to any question with **Put on the board now**
- **import** a pack (replace or add), **export** to JSON, **print answer sheets**, or reload the sample pack

You can also jump to any question, or a random unplayed one (⚄), from the round bar.

### Pack format (JSON)

```json
{
  "title": "My Pack",
  "questions": [
    {
      "question": "Name something you find in a kitchen.",
      "answers": [ { "text": "Fridge", "points": 35 }, { "text": "Stove", "points": 25 } ],
      "multiplier": 2
    }
  ],
  "fastMoney": [
    { "question": "Name a yellow fruit.", "answers": [ { "text": "Banana", "points": 62 } ] }
  ]
}
```

`multiplier` is optional. Imports are forgiving: answers can also be written as `["Fridge", 35]` or `"Fridge 35"`, and the file can be a plain list of questions. See `packs/template.json` and `packs/sample-pack.json`.

## 6. Fast Money

Switch to the **Fast Money** tab at the top.

1. Read each question. Type the player's answer.
2. Pick the matching survey answer. An exact match is picked for you.
3. Press **Reveal**. The answer appears on the display, then its points.

The timers use 20 and 25 seconds by default. Other controls:

- **Hide player 1 answers** while player 2 plays. It switches on automatically when you select Player 2.
- **Dup** plays the duplicate-answer buzzer.

Reaching the goal (200 by default) triggers the celebration.

## 7. Settings

Configurable rules:

- strikes before a steal
- the multiplier for each round (default `1, 1, 2, 3`; the last value repeats)
- winning score (300 by default; 0 turns it off)
- whether face-off answers and steal answers add to the bank
- automatic award when the board is cleared
- sudden-death multiplier
- automatic face-off and steal timers
- Fast Money goal and times
- shuffling the question order
- sound on/off, volume, and which window plays sound

**Backups:** under Settings you can download one file containing the game, questions, settings and history. Restore it on any computer.

## Keyboard shortcuts

| Key | Action |
|---|---|
| 1–9, 0 | Reveal answer 1–10 (Shift = no points) |
| X | Wrong answer / strike / steal failed |
| A | Reveal all remaining |
| [ / ] | Face-off won by team 1 / team 2 |
| P / Shift+P | Face-off winner plays / passes |
| N | Next round |
| Q | Show/hide the question on the display |
| T | Start/pause the timer |
| D | Open the display window |
| Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z | Undo / redo |
| F (on display) | Fullscreen |
| ? | Help |

## Good to know

- Progress saves automatically after every action, in this browser's local storage. Closing the tab or rebooting won't lose the game. Use the same browser, and the same address (`localhost:8080` or the file), to pick up where you left off.
- Keep only **one** Host Console tab open.
- The display never receives unrevealed answers, so they can't leak onto the projector.
- Sound effects are generated in the browser. There are no audio files and no network requests.
- **New Game** saves the current game to **History**, and Undo brings it back.
