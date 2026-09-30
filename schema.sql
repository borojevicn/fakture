-- Fakture Borojević — šema baze (Supabase / Postgres)
-- Zalepi ceo ovaj fajl u Supabase → SQL Editor → New query → Run.

create extension if not exists "pgcrypto";

-- Podešavanja (jedan red: podaci firme i podrazumevane vrednosti)
create table if not exists settings (
  id int primary key default 1 check (id = 1),
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Kupci
create table if not exists clients (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  addr text default '',
  pib text default '',
  mb text default '',
  email text default '',
  created_at timestamptz not null default now()
);
create unique index if not exists clients_name_key on clients (lower(name));

-- Usluge (padajući meni)
create table if not exists services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  unit text not null default 'usluga',
  default_price numeric(14,2),
  sort int not null default 0,
  created_at timestamptz not null default now()
);

-- Fakture
create table if not exists invoices (
  id uuid primary key default gen_random_uuid(),
  year int not null,
  number int not null,
  full_no text not null,
  issue_date date not null,
  service_date date,
  due_date date,
  place text default '',
  client_id uuid references clients(id) on delete set null,
  client jsonb not null default '{}'::jsonb,   -- snimak podataka kupca u trenutku izdavanja
  items jsonb not null default '[]'::jsonb,    -- stavke: [{svc, desc, unit, qty, price, total}]
  total numeric(14,2) not null default 0,
  note_vat text default '',
  note_extra text default '',
  status text not null default 'izdata' check (status in ('izdata','placena','storno')),
  paid_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (year, number)
);
create index if not exists invoices_issue_date_idx on invoices (issue_date desc);

-- Pristup: samo ulogovani korisnici (tata), niko spolja
alter table settings enable row level security;
alter table clients  enable row level security;
alter table services enable row level security;
alter table invoices enable row level security;

drop policy if exists "auth all" on settings;
drop policy if exists "auth all" on clients;
drop policy if exists "auth all" on services;
drop policy if exists "auth all" on invoices;

create policy "auth all" on settings for all to authenticated using (true) with check (true);
create policy "auth all" on clients  for all to authenticated using (true) with check (true);
create policy "auth all" on services for all to authenticated using (true) with check (true);
create policy "auth all" on invoices for all to authenticated using (true) with check (true);

-- Početni podaci
insert into settings (id, data) values (1, '{
  "name": "STR I KOMISION ZORKA BOROJEVIĆ JOVICA PR KUPINOVO",
  "owner": "Jovica Borojević",
  "addr": "Maršala Tita 8, 22419 Kupinovo",
  "pib": "102085307",
  "mb": "54825099",
  "code": "",
  "phone": "064 140 3229",
  "email": "jovica.borojevic@gmail.com",
  "acc": "160-6000002721909-73",
  "bank": "Banca Intesa AD Beograd",
  "place": "Kupinovo",
  "due_days": 8,
  "note_vat": "Obveznik nije u sistemu PDV-a. PDV nije obračunat na fakturi u skladu sa članom 33. Zakona o porezu na dodatu vrednost."
}'::jsonb) on conflict (id) do nothing;

insert into services (name, unit, sort)
select 'Usluga prevoza', 'usluga', 1
where not exists (select 1 from services);
