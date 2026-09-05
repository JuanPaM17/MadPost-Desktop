create or replace function public.delete_supply(p_supply_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.product_supplies
  where supply_id = p_supply_id;

  delete from public.supplies
  where id = p_supply_id;
end;
$$;

grant execute on function public.delete_supply(uuid) to service_role;
