'use client';

import Link from 'next/link';
import {useParams, usePathname} from 'next/navigation';

export default function LocaleSwitcher({locale}) {
  const params = useParams();
  const pathname = usePathname();

  const to = (target) => {
    return pathname.replace(/^\/(zh|en)/, `/${target}`);
  };

  return (
    <div className="inline-flex items-center gap-2">
      <Link href={to('zh')} className={`px-3 py-1 rounded border ${locale==='zh' ? 'bg-sky-600 text-white' : 'hover:bg-slate-100'}`}>中文</Link>
      <Link href={to('en')} className={`px-3 py-1 rounded border ${locale==='en' ? 'bg-sky-600 text-white' : 'hover:bg-slate-100'}`}>EN</Link>
    </div>
  );
}
