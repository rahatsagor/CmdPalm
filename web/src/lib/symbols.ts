import type { Component } from 'vue'
import {
  Aperture, AppWindow, ArrowLeft, ArrowLeftToLine, ArrowRight, ArrowRightToLine, AtSign, Battery,
  Bell, Bluetooth, Bookmark, Bot, Calendar, Camera, ChevronLeft, ChevronRight, CirclePlay, Clipboard,
  Cloud, Code, Coffee, Command, Copy, Download, EyeOff, FastForward, File, Film, Flame, Folder,
  Gamepad2, Globe, Grid2x2, Hash, Headphones, Heart, House, Image, Keyboard, Laptop, LayoutGrid,
  Lightbulb, LightbulbOff, Link, ListOrdered, Lock, Mail, Maximize, MessageCircle, Mic, Minimize,
  Monitor, MonitorOff, Moon, Mouse, MousePointerClick, Music, OctagonX, Phone, Plus, Power, Redo,
  RefreshCw, Repeat, Rewind, Rocket, RotateCw, Scan, ScanSearch, Scissors, Search, Settings,
  SkipBack, SkipForward, SlidersHorizontal, Smile, Sparkles, SquareTerminal, Star, Sun, SunDim,
  Terminal, TextSelect, Timer, Trash2, Type, Undo, Upload, Video, Volume1, Volume2, VolumeX, Wifi,
  Workflow, X, Zap, ZoomIn, ZoomOut,
} from '@lucide/vue'

/** Glyphs available for deck buttons, by stable name (stored in decks). */
export const SYMBOLS: Record<string, Component> = {
  'layout-grid': LayoutGrid, 'app-window': AppWindow, monitor: Monitor, 'grid-2x2': Grid2x2,
  'arrow-left-to-line': ArrowLeftToLine, 'arrow-right-to-line': ArrowRightToLine, repeat: Repeat,
  maximize: Maximize, minimize: Minimize, x: X, 'eye-off': EyeOff, power: Power, search: Search,
  smile: Smile, camera: Camera, scan: Scan, aperture: Aperture, 'octagon-x': OctagonX, lock: Lock,
  'monitor-off': MonitorOff, moon: Moon, undo: Undo, redo: Redo, copy: Copy, scissors: Scissors,
  clipboard: Clipboard, 'text-select': TextSelect, plus: Plus, 'chevron-right': ChevronRight,
  'chevron-left': ChevronLeft, 'arrow-left': ArrowLeft, 'arrow-right': ArrowRight,
  'rotate-cw': RotateCw, 'zoom-in': ZoomIn, 'zoom-out': ZoomOut, 'scan-search': ScanSearch,
  'play-pause': CirclePlay, 'skip-forward': SkipForward, 'skip-back': SkipBack,
  'fast-forward': FastForward, rewind: Rewind, 'volume-2': Volume2, 'volume-1': Volume1,
  'volume-x': VolumeX, sun: Sun, 'sun-dim': SunDim, lightbulb: Lightbulb,
  'lightbulb-off': LightbulbOff, command: Command, laptop: Laptop, music: Music, type: Type,
  link: Link, workflow: Workflow, 'mouse-pointer-click': MousePointerClick,
  'list-ordered': ListOrdered, timer: Timer, 'square-terminal': SquareTerminal, zap: Zap,
  star: Star, heart: Heart, house: House, mail: Mail, 'message-circle': MessageCircle,
  calendar: Calendar, folder: Folder, file: File, terminal: Terminal, code: Code, globe: Globe,
  bookmark: Bookmark, bell: Bell, mic: Mic, video: Video, phone: Phone, coffee: Coffee,
  'gamepad-2': Gamepad2, headphones: Headphones, image: Image, film: Film, cloud: Cloud,
  download: Download, upload: Upload, 'refresh-cw': RefreshCw, settings: Settings,
  'sliders-horizontal': SlidersHorizontal, 'trash-2': Trash2, wifi: Wifi, bluetooth: Bluetooth,
  battery: Battery, keyboard: Keyboard, mouse: Mouse, hash: Hash, 'at-sign': AtSign,
  sparkles: Sparkles, rocket: Rocket, flame: Flame, bot: Bot,
}

export function symbol(name: string | undefined): Component {
  return (name && SYMBOLS[name]) || Zap
}
