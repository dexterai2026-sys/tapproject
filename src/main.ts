import './style.css';
import { loadSettings } from './settings';
import { applyDisplay } from './ui/display';
import { initShell } from './ui/nav';
import { showTab } from './ui/screens';

applyDisplay(loadSettings());
initShell(showTab);
showTab('games');
