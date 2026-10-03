<script setup>
import {watch,ref,nextTick} from 'vue';import Icon from './Icon.vue';
const props=defineProps({open:Boolean,title:String,wide:Boolean});const emit=defineEmits(['close']);const dialog=ref();let previous;
watch(()=>props.open,async v=>{await nextTick();if(v){previous=document.activeElement;dialog.value.showModal();}else{dialog.value?.close();previous?.focus?.();}});
</script>
<template><Teleport to="body"><dialog ref="dialog" class="modal" :class="{wide}" @cancel.prevent="emit('close')" @click="e=>{if(e.target===dialog)emit('close')}"><header class="modal-head"><div><span class="eyebrow">ESPACE STUDIO / BIROSTWEB</span><h2>{{ title }}</h2></div><button class="icon-button" aria-label="Fermer" @click="emit('close')"><Icon name="X"/></button></header><div class="modal-body"><slot/></div></dialog></Teleport></template>
