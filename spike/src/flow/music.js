// Copied raw from ../flow/public/music.js (Flow, GPL-3.0): the instrument table and pitch helpers.
// M0 spike only; the clean port happens in M3. One change: parseChord also takes 7sus4 (issue #6's G7sus4).
// @ts-nocheck

export const instrumentGroups=['Experimental textures','Pads & atmosphere','Strings & choir','Air & woodwind','Keys & bells'];
export const instruments={
 piano:{name:'Grand piano',file:'0000',gain:.30,group:'Keys & bells'},
 rhodes:{name:'Electric piano',file:'0040',gain:.34,group:'Keys & bells'},
 celesta:{name:'Celesta',file:'0080',gain:.28,group:'Keys & bells'},
 musicbox:{name:'Music box',file:'0100',gain:.22,group:'Keys & bells'},
 vibes:{name:'Vibraphone',file:'0110',gain:.32,group:'Keys & bells'},
 bells:{name:'Tubular bells',file:'0140',gain:.20,group:'Keys & bells'},
 strings:{name:'Warm strings',file:'0480',gain:.13,group:'Strings & choir'},
 pad:{name:'Warm pad',file:'0890',gain:.26,group:'Pads & atmosphere'},
 slowstrings:{name:'Slow strings',file:'0490',gain:.18,group:'Strings & choir',attack:.55,duration:5,release:1.5},
 synthstrings:{name:'Synth strings',file:'0500',gain:.20,group:'Strings & choir',attack:.45,duration:4.8,release:1.4},
 choir:{name:'Choir aahs',file:'0520',gain:.17,group:'Strings & choir',attack:.45,duration:4.8,release:1.4},
 oohs:{name:'Voice oohs',file:'0530',gain:.19,group:'Strings & choir',attack:.4,duration:4.6,release:1.3},
 flute:{name:'Flute',file:'0730',gain:.25,group:'Air & woodwind',attack:.18,duration:3.8,release:1},
 panflute:{name:'Pan flute',file:'0750',gain:.23,group:'Air & woodwind',attack:.22,duration:3.8,release:1},
 ocarina:{name:'Ocarina',file:'0790',gain:.22,group:'Air & woodwind',attack:.25,duration:4,release:1.1},
 newage:{name:'New age pad',file:'0880',gain:.075,group:'Pads & atmosphere',attack:.75,duration:3.8,release:1.15,tone:{type:'lowpass',from:2800,to:1700,time:1.8,q:.45}},
 choirpad:{name:'Choir pad',file:'0910',gain:.19,group:'Pads & atmosphere',attack:.65,duration:5.2,release:1.6},
 bowedpad:{name:'Bowed pad',file:'0920',gain:.20,group:'Pads & atmosphere',attack:.6,duration:5.2,release:1.6},
 halo:{name:'Halo pad',file:'0940',gain:.21,group:'Pads & atmosphere',attack:.7,duration:5.4,release:1.7},
 sweeppad:{name:'Sweep pad',file:'0950',gain:.20,group:'Pads & atmosphere',attack:.75,duration:5.4,release:1.7},
 prismrain:{name:'Prism rain',file:'0960',gain:.20,group:'Experimental textures',attack:.28,duration:4.6,release:1.4,tone:{type:'lowpass',from:1100,to:6200,time:2.2,q:.7}},
 soundtrack:{name:'Distant soundtrack',file:'0970',gain:.16,group:'Experimental textures',attack:.8,duration:6,release:1.8,tone:{type:'lowpass',from:4300,to:850,time:3.5,q:.65}},
 crystal:{name:'Crystal bloom',file:'0980',gain:.23,group:'Experimental textures',attack:.18,duration:3.8,release:1.2,tone:{type:'lowpass',from:7200,to:1900,time:2,q:.65}},
 deepatmosphere:{name:'Deep atmosphere',file:'0990',gain:.26,group:'Experimental textures',attack:.4,duration:6.2,release:1.8,tone:{type:'lowpass',from:950,to:4800,time:3.3,q:.75}},
 prismaticair:{name:'Prismatic air',file:'1000',gain:.16,group:'Experimental textures',attack:.32,duration:4.5,release:1.4,tone:{type:'lowpass',from:1500,to:7500,time:2.4,q:.65}},
 alienchorus:{name:'Alien chorus',file:'1010',gain:.16,group:'Experimental textures',attack:.65,duration:5.2,release:1.6,tone:{type:'bandpass',from:450,to:2300,time:2.9,q:.65}},
 echofragments:{name:'Echo fragments',file:'1020',gain:.19,group:'Experimental textures',attack:.25,duration:4.2,release:1.4,tone:{type:'lowpass',from:5800,to:1500,time:2.3,q:.7}},
 orbitalsignal:{name:'Orbital signal',file:'1030',gain:.20,group:'Experimental textures',attack:.28,duration:5,release:1.5,tone:{type:'bandpass',from:1400,to:420,time:3,q:.45}}

};
export const instrumentKeys=Object.keys(instruments);
export function softEnvelope(voice){return [{duration:0,volume:0},{duration:voice.attack,volume:1},{duration:.65,volume:.82},{duration:voice.duration-voice.attack-.65-voice.release,volume:.68},{duration:voice.release,volume:0}];}
const roots={C:0,D:2,E:4,F:5,G:7,A:9,B:11};
export function parseChord(symbol){const m=/^([A-G])([#b]?)(maj9|maj7|dim7|dim|°7|°|m9|m7|m6|m|9|7sus4|7|6|sus2|sus4|sus|add9)?$/.exec(symbol.trim());if(!m)throw new Error('Try Cmaj7, Am7, Bdim, C#dim7, Dsus2, or Gsus4 (sus means sus4).');let root=roots[m[1]]+(m[2]==='#'?1:m[2]==='b'?-1:0);root=(root+12)%12;const shape={dim:[0,3,6],dim7:[0,3,6,9],"°":[0,3,6],"°7":[0,3,6,9],sus:[0,5,7],'7sus4':[0,5,7,10],maj9:[0,4,7,11,14],m9:[0,3,7,10,14],9:[0,4,7,10,14],6:[0,4,7,9],m6:[0,3,7,9],maj7:[0,4,7,11],m7:[0,3,7,10],m:[0,3,7],7:[0,4,7,10],sus2:[0,2,7],sus4:[0,5,7],add9:[0,4,7,14]}[m[3]]||[0,4,7];return shape.map(n=>48+root+n);}
export function normalizeOctaveRange({down=0,up=1}={}){
 const octave=(value,fallback)=>Number.isFinite(Number(value))?Math.max(0,Math.min(3,Math.round(Number(value)))):fallback;
 return {down:octave(down,0),up:octave(up,1)};
}
export function pitchesForRange(chord,voice=0,range={}){
 const {down,up}=normalizeOctaveRange(range),base=parseChord(chord),notes=[];
 for(let octave=-down;octave<=up;octave++)for(const note of base)notes.push(note+octave*12-(voice===2?12:0));
 // Extended chords can overlap registers; always move upward from left to right.
 return [...new Set(notes)].filter(note=>note>=0&&note<=127).sort((a,b)=>a-b);
}
export function pitchForPosition(chord,x,voice=0,range={}){
 const notes=pitchesForRange(chord,voice,range),position=Number.isFinite(x)?Math.max(0,Math.min(1,x)):0;
 return notes[Math.min(notes.length-1,Math.floor(position*notes.length))];
}
export function noteName(pitch){return ['C','C♯','D','E♭','E','F','F♯','G','A♭','A','B♭','B'][pitch%12]+(Math.floor(pitch/12)-1);}
export const progressions={daydream:['Cmaj7','Am7','Fmaj7','G'],weightless:['Dmaj7','A','Bm7','Gmaj7'],afterhours:['Am7','Fmaj7','Cmaj7','Em7'],openwater:['Fmaj7','Cmaj7','Em7','Am7'],
 stilllight:["Dbmaj9","Fm7","Bbm9","Gbmaj9"],
 tidalglass:["Dsus2","Aadd9","Gmaj7","Esus4"],
 bluehour:["Dm9","G9","Cmaj9","Am9"],
 dorianbloom:["Dm9","G6","Em7","G6"],
 velvetundertow:["Am9","Fmaj9","Dm9","Em7"],
 borrowedlight:["Cmaj9","Em7","Fmaj9","Fm6"],
 chromaticorbit:["Cmaj9","Abmaj9","Emaj9","Abmaj9"],
 slowdescent:["Fmaj9","Em7","Dm9","C6"],
 suspendedsky:["Csus2","Gsus4","Asus2","Fsus4"],
 passingcloud:["Cmaj7","C#dim7","Dm7","G7"],
 duskturn:["Am","Bdim","E7","Am"]
};
