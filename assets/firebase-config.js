// Konfigurace Firebase pro sdílené pozice portfolia.
//
// Používáme stejný Firebase projekt jako web RD Modřice (rd-modrice-e9477),
// jen novou kolekci Firestore "portfolio_pozice" – ať nemusíme zakládat
// a spravovat druhý projekt. apiKey je veřejná (běžné pro web SDK) –
// bezpečnost řeší pravidla Firestore, ne skrývání configu.
//
// Aby pozice šly ukládat sdíleně, musí mít Firestore pravidla povolené
// čtení i zápis kolekce "portfolio_pozice" (stejně jako mají "poznamky",
// "pozadavky" apod. pro RD Modřice) – nastavuje se ve Firebase konzoli,
// Firestore Database → Rules.

export const firebaseConfig = {
  apiKey: "AIzaSyCLU7cH1tXPqnaxVV_-BsSNssl-NU9Pz1I",
  authDomain: "rd-modrice-e9477.firebaseapp.com",
  projectId: "rd-modrice-e9477",
  storageBucket: "rd-modrice-e9477.firebasestorage.app",
  messagingSenderId: "941681195558",
  appId: "1:941681195558:web:3aac10f182e784cdb3c4e7"
};

export const POSITIONS_COLLECTION = "portfolio_pozice";
