# MIDI Note Hero

A small browser game for a USB MIDI keyboard. It asks for Web MIDI permission, lists available MIDI inputs, shows the note numbers you play, and runs a simple falling-note round where you hit matching MIDI note numbers near the target line.

## Run

```sh
npm start
```

Then open <http://localhost:4173>.

Use Chrome or Edge. Safari and Firefox do not currently expose the Web MIDI API in the same way.

The app includes a simple browser synth, so you should hear notes from your computer speakers after clicking `Connect MIDI`. If the live note numbers move but you do not hear sound, check the browser tab volume, the app Volume slider, and your macOS output device.

## Keystation 49 notes

Easy mode is the default and only uses notes `60` to `72`. Middle mode uses `48` to `72`, and Full custom lets you choose the exact low/high note range. If your Keystation is shifted by octave buttons, either reset the keyboard octave or use Full custom.

The falling notes are positioned over a rendered piano keyboard: white notes align to white keys, and sharp/flat notes align to the black keys between them.

Turn on `White keys only` to stop rounds from targeting black keys. Imported MIDI/audio notes are remapped to the nearest playable white key while that option is enabled.

## MIDI song import

Use the Song file input to load a `.mid`, `.midi`, or audio file such as `.mp3`. MIDI files use their real note-on events. Audio files are decoded in the browser and converted into a rough generated chart by detecting strong note/onset moments and estimating pitch near each onset. In Easy or Middle mode, imported/generated notes are kept inside the active keyboard range so the round stays playable on a smaller section of the keyboard.

MP3 generation is approximate. It is good enough for a first playable chart, but MIDI files will produce much cleaner note rounds because they contain actual note data.
