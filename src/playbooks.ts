// Guided troubleshooting trees, written the way a help desk tech walks a caller through a fix:
// one instruction or question at a time, the cheapest and most likely fix first, and an
// honest hand-off to a ticket when the remaining steps need hands on the device.

export type Outcome = "fixed" | "escalate";

export interface PlaybookNode {
  say: string; // what the assistant says or asks
  answers?: Record<string, string>; // answer keyword -> next node id
  check?: string; // service key to check live before continuing
  outcome?: Outcome; // terminal node
  priority?: "low" | "normal" | "high" | "urgent";
}

export interface Playbook {
  title: string;
  match: string[]; // words that select this playbook
  start: string;
  nodes: Record<string, PlaybookNode>;
}

const YES_NO = (yes: string, no: string) => ({ yes, no });

export const PLAYBOOKS: Record<string, Playbook> = {
  internet: {
    title: "Internet or Wi-Fi not working",
    match: ["wifi", "wi-fi", "internet", "network", "router", "connection", "offline", "no connection"],
    start: "scope",
    nodes: {
      scope: {
        say: "Is the internet down on every device in the house, or only on one device?",
        answers: { all: "router_lights", every: "router_lights", one: "one_toggle", only: "one_toggle" },
      },
      router_lights: {
        say: "Look at the router. Are its lights on, with no red or orange warning light?",
        answers: YES_NO("router_restart", "power_check"),
      },
      power_check: {
        say: "Check that the router and the modem are plugged in and switched on, and that the cable from the wall is firmly in the port marked WAN or Internet. Did the lights come back?",
        answers: YES_NO("retest", "router_restart"),
      },
      router_restart: {
        say: "Unplug the modem and the router, wait 30 seconds, plug the modem in first and give it two minutes, then plug in the router and wait another two minutes. Is the internet back?",
        answers: YES_NO("done", "isp"),
      },
      isp: {
        say: "Your equipment is up but the line isn't. That usually means a provider outage or a line fault, which only your internet provider can fix. I'll open a ticket with everything we tried so whoever calls them has it in front of them.",
        outcome: "escalate",
        priority: "high",
      },
      one_toggle: {
        say: "On that device, turn Wi-Fi off, wait ten seconds, and turn it back on. Also make sure airplane mode is off. Did that fix it?",
        answers: YES_NO("done", "one_restart"),
      },
      one_restart: { say: "Restart the device completely. Is it working after the restart?", answers: YES_NO("done", "one_forget") },
      one_forget: {
        say: "Open the device's Wi-Fi settings, choose your network, select Forget, then join it again and re-enter the Wi-Fi password. Working now?",
        answers: YES_NO("done", "one_escalate"),
      },
      one_escalate: {
        say: "Other devices work, so the problem is in this device's network settings or its Wi-Fi hardware. That needs someone at the keyboard, so I'm opening a ticket with every step we already tried.",
        outcome: "escalate",
        priority: "normal",
      },
      retest: { say: "Give it two minutes and try loading a website. Is the internet back?", answers: YES_NO("done", "router_restart") },
      done: { say: "Great, you're back online. I'll note what fixed it in case it happens again.", outcome: "fixed" },
    },
  },
  printer: {
    title: "Printer offline or not printing",
    match: ["print", "printer", "printing", "scanner", "toner", "paper jam"],
    start: "panel",
    nodes: {
      panel: {
        say: "Is the printer switched on, with no error on its screen, like a paper jam, an open door, or empty ink or toner?",
        answers: { yes: "same_network", no: "panel_fix", error: "panel_fix" },
      },
      panel_fix: {
        say: "Clear what the printer is complaining about: remove jammed paper gently in the direction it travels, close every door and tray, or replace the empty cartridge. Then try printing again. Did it print?",
        answers: YES_NO("done", "same_network"),
      },
      same_network: {
        say: "Restart the printer: switch it off, wait 30 seconds, and switch it on. Wait until it says ready, then print a test page from the computer. Did it print?",
        answers: YES_NO("done", "queue"),
      },
      queue: {
        say: "On the computer, open the printer's print queue and cancel every waiting document, because one stuck job blocks everything behind it. Then print again. Did it work?",
        answers: YES_NO("done", "readd"),
      },
      readd: {
        say: "In the computer's printer settings, remove this printer, then add it again so the computer finds it fresh on the network. Try printing once more. Did it work?",
        answers: YES_NO("done", "escalate"),
      },
      escalate: {
        say: "We've covered everything that can be done by voice. The next steps are driver or network work on the computer, so I'm opening a ticket with the steps we already tried.",
        outcome: "escalate",
        priority: "normal",
      },
      done: { say: "Printing again. I'll remember which fix worked for this printer.", outcome: "fixed" },
    },
  },
  email: {
    title: "Email not sending or not syncing",
    match: ["email", "e-mail", "mail", "outlook", "gmail", "inbox", "hotmail"],
    start: "provider",
    nodes: {
      provider: {
        say: "Which email do you use: Gmail or Outlook?",
        answers: { gmail: "check_google", google: "check_google", outlook: "check_outlook", hotmail: "check_outlook", other: "webmail" },
      },
      check_google: { say: "Checking Google's status page.", check: "google", answers: { continue: "webmail" } },
      check_outlook: { say: "Checking Microsoft's status page.", check: "outlook", answers: { continue: "webmail" } },
      webmail: {
        say: "Open your email in a web browser instead of the app. Does it work in the browser?",
        answers: YES_NO("app_side", "account_side"),
      },
      app_side: {
        say: "Then the account is fine and the mail app is the problem. Close the app fully and open it again. If you changed your password recently, the app will ask for the new one. Is mail flowing now?",
        answers: YES_NO("done", "app_readd"),
      },
      app_readd: {
        say: "Remove the account from the mail app and add it back with your current password. Working now?",
        answers: YES_NO("done", "escalate"),
      },
      account_side: {
        say: "If even the browser fails, check two things: that your mailbox is not full, and that you can sign in at all. Can you sign in to the web version?",
        answers: { yes: "storage", no: "signin" },
      },
      storage: {
        say: "Look for a storage-full warning. If you see one, delete large old messages and empty the trash, then try again. Fixed?",
        answers: YES_NO("done", "escalate"),
      },
      signin: {
        say: "Use the official password reset page for your email provider, never a link from an email. Did that get you back in?",
        answers: YES_NO("done", "escalate"),
      },
      escalate: {
        say: "This needs a closer look at the account settings, so I'm opening a ticket with everything we checked.",
        outcome: "escalate",
        priority: "normal",
      },
      done: { say: "Your email is working again.", outcome: "fixed" },
    },
  },
  calls: {
    title: "Video call audio or camera problems",
    match: ["zoom", "teams", "meet", "camera", "webcam", "microphone", "mic", "audio", "sound", "video call", "can't hear"],
    start: "which_app",
    nodes: {
      which_app: {
        say: "Which app is the call in: Zoom, Teams, or Google Meet?",
        answers: { zoom: "check_zoom", teams: "check_teams", meet: "check_google", google: "check_google" },
      },
      check_zoom: { say: "Checking Zoom's status page.", check: "zoom", answers: { continue: "devices" } },
      check_teams: { say: "Checking Microsoft's status page.", check: "teams", answers: { continue: "devices" } },
      check_google: { say: "Checking Google's status page.", check: "google", answers: { continue: "devices" } },
      devices: {
        say: "In the call app's settings, open Audio and Video and check that the right microphone, speaker and camera are selected. A headset or a TV often takes over without telling you. Does it work now?",
        answers: YES_NO("done", "permissions"),
      },
      permissions: {
        say: "Check the computer's privacy settings: the call app must be allowed to use the camera and the microphone. Then close any other app that might be using the camera. Working now?",
        answers: YES_NO("done", "restart_app"),
      },
      restart_app: {
        say: "Quit the call app completely and open it again, then use its built-in test call or speaker test. Do you hear and see yourself?",
        answers: YES_NO("done", "escalate"),
      },
      escalate: {
        say: "This may be a driver or hardware problem, so I'm opening a ticket with what we tried.",
        outcome: "escalate",
        priority: "normal",
      },
      done: { say: "You're good to go for the call.", outcome: "fixed" },
    },
  },
  slow: {
    title: "Computer is slow",
    match: ["slow", "freezing", "frozen", "hangs", "laggy", "lag", "takes forever", "fan"],
    start: "restart",
    nodes: {
      restart: {
        say: "When was the computer last fully restarted? Do a real restart now, not sleep, and tell me: is it faster afterwards?",
        answers: YES_NO("done", "updates"),
      },
      updates: {
        say: "Check whether system updates are waiting or installing. Updates running in the background slow everything down. Were updates pending?",
        answers: { yes: "updates_finish", no: "disk" },
      },
      updates_finish: { say: "Let the updates finish and restart once more. Better?", answers: YES_NO("done", "disk") },
      disk: {
        say: "Check the free space on the main drive. Is less than about ten percent free?",
        answers: { yes: "disk_clean", no: "apps" },
      },
      disk_clean: {
        say: "Empty the trash or recycle bin and remove large files or programs you no longer need, then restart. Better?",
        answers: YES_NO("done", "apps"),
      },
      apps: {
        say: "Close programs you're not using, especially browser windows with many tabs, and check which apps start automatically when the computer turns on. Faster now?",
        answers: YES_NO("done", "escalate"),
      },
      escalate: {
        say: "It's still slow after the usual fixes, which can mean failing hardware or malware. I'm opening a ticket so someone can check it properly.",
        outcome: "escalate",
        priority: "normal",
      },
      done: { say: "Good. A weekly restart keeps it that way.", outcome: "fixed" },
    },
  },
  signin: {
    title: "Can't sign in or locked out",
    match: ["password", "sign in", "signin", "log in", "login", "locked", "two-factor", "2fa", "mfa", "authenticator", "verification code"],
    start: "keyboard",
    nodes: {
      keyboard: {
        say: "First the classic: check that Caps Lock is off and the keyboard is set to the right language. A password typed on a Hebrew or Arabic layout looks right but is wrong. Try once more carefully. Did it work?",
        answers: YES_NO("done", "reset"),
      },
      reset: {
        say: "Use the service's own Forgot Password page. Type the site address yourself instead of clicking a link from an email or a text message. Were you able to reset it?",
        answers: YES_NO("done", "mfa"),
      },
      mfa: {
        say: "Is the problem the verification code, for example a new phone or the authenticator app is gone?",
        answers: { yes: "mfa_backup", no: "escalate" },
      },
      mfa_backup: {
        say: "Look for backup codes you saved when you set it up, or another device still signed in. Never read a code to anyone who calls you asking for it. Did that get you in?",
        answers: YES_NO("done", "escalate"),
      },
      escalate: {
        say: "Account recovery has to go through the account owner or the service's support, so I'm opening a ticket. Remember: real support never asks you for your password or a code.",
        outcome: "escalate",
        priority: "high",
      },
      done: { say: "You're signed in. Consider saving backup codes somewhere safe.", outcome: "fixed" },
    },
  },
};

export function pickPlaybook(problem: string): string | null {
  const q = problem.toLowerCase();
  let best: { key: string; hits: number } | null = null;
  for (const [key, pb] of Object.entries(PLAYBOOKS)) {
    const hits = pb.match.filter((m) => q.includes(m)).length;
    if (hits && (!best || hits > best.hits)) best = { key, hits };
  }
  return best?.key ?? null;
}

// Map a free-form spoken answer onto one of the node's answer keys.
export function matchAnswer(node: PlaybookNode, answer: string): string | null {
  if (!node.answers) return null;
  const a = answer.trim().toLowerCase();
  const keys = Object.keys(node.answers);
  const direct = keys.find((k) => a === k || a.split(/\W+/).includes(k));
  if (direct) return direct;
  const yesWords = ["yes", "yeah", "yep", "it worked", "works", "fixed", "back", "correct", "sure", "it did", "done", "ok"];
  const noWords = ["no", "nope", "not", "didn't", "doesn't", "still", "nothing", "same"];
  if (keys.includes("no") && noWords.some((w) => a.split(/\W+/).includes(w) || a.includes(w + " "))) return "no";
  if (keys.includes("yes") && yesWords.some((w) => a.includes(w))) return "yes";
  if (keys.includes("continue")) return "continue";
  return null;
}
