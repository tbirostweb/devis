<script setup>defineProps({number:{type:String,default:'01'},title:String,subtitle:String});</script>
<template><div class="page-heading"><div><div class="eyebrow"><span class="accent">[{{number}}]</span> BIROSTWEB / ESPACE STUDIO</div><h1>{{title}}<span class="accent">.</span></h1><p v-if="subtitle">{{subtitle}}</p></div><div class="heading-actions"><slot/></div></div></template>
